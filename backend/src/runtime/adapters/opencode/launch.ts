/**
 * OpenCode 的启动准备。
 *
 * 两种模式都经 `OPENCODE_CONFIG_CONTENT` 交一份运行时 JSON（OpenCode 最后加载它）：
 *   `instructions`（用户已有的 + 本对话的指令文件路径）· `mcp`（托管 MCP）· `permission: {"*": "allow"}` · `autoupdate: false` · `share: disabled`。
 * **不重定向 HOME / XDG_***：那会连带改掉 git、ssh、npm 与子 shell 的配置来源。
 *
 * global：用户自己的配置目录与会话库（原生会话可续）。
 * scoped：再加 `OPENCODE_DB=<运行时 home>/opencode.db`（原生会话按对话隔离）、`OPENCODE_DISABLE_CLAUDE_CODE=1`，
 *   运行时 JSON 里 `enabled_providers: ["clawopt"]`（否则没配好时会悄悄回落到免费模型）、
 *   `provider.clawopt`（`@ai-sdk/openai`，baseURL 指向代理，`apiKey: "{env:CLAWOPT_OPENCODE_API_KEY}"`——令牌不进配置内容）。
 */
import path from 'path';
import type { ManagedMcpServer } from '../_platform-types';
import type { PrepareContext, PreparedLaunch } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { PlannedFile } from '../_shared/runtime-fs';

export const OPENCODE_PROVIDER_ID = 'clawopt';
export const OPENCODE_TOKEN_ENV = 'CLAWOPT_OPENCODE_API_KEY';
export const OPENCODE_RULES_FILE = 'clawopt-rules.md';

export function opencodeMcpConfig(servers: readonly ManagedMcpServer[]): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const server of servers) {
    mcp[server.name] = server.transport === 'http'
      ? { type: 'remote', url: server.url, ...(server.headers ? { headers: server.headers } : {}), enabled: true }
      : { type: 'local', command: [server.command ?? '', ...(server.args ?? [])], ...(server.env ? { environment: server.env } : {}), enabled: true };
  }
  return mcp;
}

/** 用户 opencode.json(c) 里已有的 instructions（JSONC 注释去掉后能解析才取）。 */
function inheritedInstructions(ctx: PrepareContext): string[] {
  const dir = ctx.processEnv.OPENCODE_CONFIG_DIR || path.join(ctx.processEnv.XDG_CONFIG_HOME || path.join(ctx.userHome, '.config'), 'opencode');
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const text = ctx.fs.readText(path.join(dir, name));
    if (!text) continue;
    try {
      const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
      if (Array.isArray(parsed?.instructions)) return parsed.instructions.filter((item: unknown): item is string => typeof item === 'string');
    } catch {
      return [];
    }
  }
  return [];
}

export function prepareOpenCodeLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }];
  const launchEnv: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: '1' };
  const args = ['run', '--format', 'json', '--auto', '--thinking'];

  const instructions = inheritedInstructions(ctx);
  if (ctx.instructions) {
    const rulesPath = path.join(homeDir, OPENCODE_RULES_FILE);
    files.push({ kind: 'file', path: rulesPath, content: `${managedPromptBlock(ctx.instructions)}\n` });
    if (!instructions.includes(rulesPath)) instructions.push(rulesPath);
  }

  const runtimeConfig: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    ...(instructions.length ? { instructions } : {}),
    ...(ctx.mcpServers.length ? { mcp: opencodeMcpConfig(ctx.mcpServers) } : {}),
    permission: { '*': 'allow' },
  };

  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const provider = request.provider;
    Object.assign(runtimeConfig, {
      enabled_providers: [OPENCODE_PROVIDER_ID],
      model: `${OPENCODE_PROVIDER_ID}/${provider.model}`,
      provider: {
        [OPENCODE_PROVIDER_ID]: {
          npm: '@ai-sdk/openai',
          name: provider.provider,
          options: { baseURL: ctx.proxyTarget.responsesBaseUrl, apiKey: `{env:${OPENCODE_TOKEN_ENV}}` },
          models: {
            [provider.model]: {
              name: provider.model,
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: provider.contextWindow ?? 128_000, output: provider.maxOutputTokens ?? 16_384 },
            },
          },
        },
      },
    });
    launchEnv.OPENCODE_DB = path.join(homeDir, 'opencode.db');
    launchEnv.OPENCODE_DISABLE_CLAUDE_CODE = '1';
    launchEnv[OPENCODE_TOKEN_ENV] = ctx.proxyTarget.token;
    args.push('-m', `${OPENCODE_PROVIDER_ID}/${provider.model}`);
    const effort = provider.reasoningEffort ?? request.reasoningEffort;
    if (effort && effort !== 'default') args.push('--variant', effort);
  } else {
    if (request.model) args.push('-m', request.model);
    if (request.reasoningEffort && request.reasoningEffort !== 'default') args.push('--variant', request.reasoningEffort);
  }
  launchEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(runtimeConfig);

  if (ctx.resume.resumeNativeId) args.push('-s', ctx.resume.resumeNativeId);
  for (const image of request.images ?? []) args.push('--file', image.path);

  // prompt 走 stdin，没有位置参数：位置参数里带空格的消息会被 OpenCode 加上字面引号。
  return { files, args, launchEnv, stdin: 'pipe', stdinData: request.prompt, cwd: request.workspace };
}
