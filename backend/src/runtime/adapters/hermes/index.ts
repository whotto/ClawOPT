/**
 * Hermes Agent 适配器（ACP）。
 *
 * global：`hermes acp --accept-hooks`，用户自己的 HERMES_HOME（~/.hermes）。
 * scoped：HERMES_HOME = `<运行时 home>/hermes-home`，config.yaml **只写 `${VAR}` 引用**：
 *   `model: {provider: custom, default: ${CLAWOPT_HERMES_MODEL}, base_url: ${CLAWOPT_HERMES_BASE_URL}, api_key: ${CLAWOPT_HERMES_API_KEY}, api_mode: anthropic_messages}`，
 *   值只在进程环境里。实测只放环境变量不写 config（OPENAI_BASE_URL + HERMES_INFERENCE_*）ACP 不认、会打到 openrouter；
 *   `providers.<名>.key_env` 那种写法首轮能跑，但跨进程 resume 会悄悄新建会话——两条都不用。
 * 指令：ACP 没有系统提示参数，作为本轮 prompt 的第一个文本块（托管块包着）。
 */
import path from 'path';
import { createAcpDriver } from '../_shared/acp';
import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type PrepareContext, type PreparedLaunch, type RuntimeDefinition } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { PlannedFile } from '../_shared/runtime-fs';
import { num } from '../_shared/turn';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import { HERMES_CAPABILITIES, HERMES_DESCRIPTOR, HERMES_GLOBAL_CREDENTIAL_ENV, HERMES_SOURCE_OF_TRUTH } from './definition';

export { HERMES_CAPABILITIES, HERMES_DESCRIPTOR, HERMES_SOURCE_OF_TRUTH } from './definition';

export const HERMES_ENV = {
  model: 'CLAWOPT_HERMES_MODEL',
  baseUrl: 'CLAWOPT_HERMES_BASE_URL',
  apiKey: 'CLAWOPT_HERMES_API_KEY',
} as const;

export function prepareHermesLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }];
  const launchEnv: Record<string, string> = {};
  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const hermesHome = path.join(homeDir, 'hermes-home');
    const config = [
      'model:',
      '  provider: custom',
      `  default: \${${HERMES_ENV.model}}`,
      `  base_url: \${${HERMES_ENV.baseUrl}}`,
      `  api_key: \${${HERMES_ENV.apiKey}}`,
      // 不用 codex_responses：Hermes 对「非 OpenAI 主机的普通 custom 端点」会忽略这个值、退回 chat_completions
      // （hermes_cli/runtime_provider.py `_resolve_plain_custom_api_mode`），而本地代理没有 chat 路由。
      // anthropic_messages 会被照办，走代理的 Anthropic 兼容路由。
      '  api_mode: anthropic_messages',
    ].join('\n');
    files.push({ kind: 'dir', path: hermesHome }, { kind: 'file', path: path.join(hermesHome, 'config.yaml'), content: `${config}\n` });
    launchEnv.HERMES_HOME = hermesHome;
    launchEnv[HERMES_ENV.model] = request.provider.model;
    launchEnv[HERMES_ENV.baseUrl] = ctx.proxyTarget.anthropicBaseUrl;
    launchEnv[HERMES_ENV.apiKey] = ctx.proxyTarget.token;
  }
  return { files, args: ['acp', '--accept-hooks'], launchEnv, stdin: 'pipe', cwd: request.workspace };
}

/**
 * Hermes 把上游错误当正文吐出来，stopReason 仍是 end_turn。实测两种形状：
 * `HTTP 401: Missing Authentication header`、`API call failed after 3 retries: HTTP 404: No endpoints found for .`
 */
export function hermesTextError(text: string): { code: 'runtime.notLoggedIn' | 'runtime.apiError'; detail: string } | null {
  const match = /^\s*(?:API call failed[^:\n]*:\s*)?HTTP (\d{3}):[^\n]*/.exec(text);
  if (!match) return null;
  return { code: match[1] === '401' || match[1] === '403' ? 'runtime.notLoggedIn' : 'runtime.apiError', detail: match[0].trim() };
}

export const HERMES_DEFINITION: RuntimeDefinition = {
  descriptor: HERMES_DESCRIPTOR,
  capabilities: HERMES_CAPABILITIES,
  sourceOfTruth: HERMES_SOURCE_OF_TRUTH,
  nativeSessionIds: 'observed',
  globalCredentialEnv: HERMES_GLOBAL_CREDENTIAL_ENV,
  supportsCommand: (kind) => kind === 'turn' || kind === 'compact',
  detectGatewayErrorText: true,
  prepare: prepareHermesLaunch,
  createDriver: (ctx) => createAcpDriver(ctx, {
    label: 'Hermes Agent',
    permissions: 'interactive',
    promptBlocks: (turn) => {
      const blocks: unknown[] = [];
      if (turn.command.kind === 'compact') {
        const extra = turn.command.instructions?.trim();
        return [{ type: 'text', text: `/compress${extra ? ` ${extra}` : ''}` }];
      }
      const instructions = [turn.request.groupSystemPrompt || turn.request.systemPrompt, turn.request.instructions].filter(Boolean).join('\n\n');
      if (instructions) blocks.push({ type: 'text', text: managedPromptBlock(instructions) });
      blocks.push({ type: 'text', text: turn.request.prompt });
      for (const image of turn.request.images ?? []) {
        if (image.data) blocks.push({ type: 'image', mimeType: image.mimeType, data: image.data });
      }
      return blocks;
    },
    configure: async (peer, sessionId, _result, turn) => {
      // global 下的模型覆盖：Hermes 的模型 id 形如 provider:model，不持久化。
      if (turn.mode === 'global' && turn.request.model) await peer.request('session/set_model', { sessionId, modelId: turn.request.model });
    },
    // Hermes 找不到会话时会「新建一个」而不报错：来历里的 acpSessionId 对不上就算没续上。
    resumeConfirmed: (requestedId, result) => {
      const provenance = result?._meta?.hermes?.sessionProvenance;
      return !provenance || provenance.acpSessionId === requestedId;
    },
    textError: hermesTextError,
    usageFromResult: (result, sessionId, turn) => {
      const usage = result?.usage;
      if (!usage || !(num(usage.inputTokens) + num(usage.outputTokens))) return null;
      return {
        callId: `hermes:${sessionId}:${turn.runId}`,
        scope: 'run',
        inputTokens: Math.max(0, num(usage.inputTokens) - num(usage.cachedReadTokens)),
        outputTokens: num(usage.outputTokens),
        cacheReadTokens: num(usage.cachedReadTokens),
        cacheWriteTokens: num(usage.cachedWriteTokens),
        reasoningTokens: num(usage.thoughtTokens),
        apiCalls: 1,
      };
    },
  }),
};

export function createHermesAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(HERMES_DEFINITION, deps);
}
