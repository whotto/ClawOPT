/**
 * Grok 的启动准备。
 *
 * prompt 每轮写进运行时 home 的一次性文件，经 `--prompt-file` 传入，收尾删除——从不进 argv。
 *
 * global：用用户自己的 GROK_HOME（与 Codex 同一个理由：影子副本里的登录令牌一旦被刷新，真实登录会失效）。
 *   指令：≤ 4 KiB 时经 `--rules`；更长就作为前言写进本轮的 prompt 文件（不进 argv）。托管 MCP 不注入——
 *   Grok 没有按次覆盖 MCP 的参数，而改用户的 config.toml 是越界。
 * scoped：GROK_HOME = 运行时 home 下的 `grok-home/`：
 *   - config.toml = 用户配置去掉模型 / 凭据 / MCP 相关 → `[models] default` 与 `session_summary` 都指向 `clawopt`
 *     （标题、摘要这类旁路调用也打到代理，而不是一个上游没有的 grok 模型）→ `[model.clawopt]`（api_backend=responses，
 *     env_key 从进程环境读令牌）→ 托管 MCP → `[cli] auto_update = false`；
 *   - AGENTS.md = 「模型身份」说明（Grok Build 只是外壳，被问到模型时报真实的上游模型）+ 用户指令 + 托管块；
 *   - 用户的 skills 目录软链共享。
 *
 * 续话就绪：`<GROK_HOME>/sessions/<encodeURIComponent(工作区)>/<id>` 存在，或任一会话桶里有这个 id
 * （工作区路径太长时 Grok 会哈希桶名）。不就绪就用 `--session-id` 新建——绝不拿一个本地没有的 id 去 `--resume`。
 */
import path from 'path';
import type { PrepareContext, PreparedLaunch } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { PlannedFile, RuntimeFs } from '../_shared/runtime-fs';
import { filterToml, mcpServersToml, tomlString } from '../_shared/toml';

export const GROK_MODEL_KEY = 'clawopt';
export const GROK_TOKEN_ENV = 'CLAWOPT_GROK_API_KEY';
export const GROK_RULES_ARG_MAX_BYTES = 4 * 1024;

const OWNED_TOP_KEYS = new Set(['model', 'default', 'default_reasoning_effort', 'context_window', 'max_completion_tokens', 'api_key', 'access_token', 'refresh_token', 'auth_token']);
const DROPPED_SECTION = (header: string) =>
  header === 'models' || header.startsWith('model.') || header === 'mcp_servers' || header.startsWith('mcp_servers.')
  || header.startsWith('auth') || header.startsWith('account') || header === 'cli';

export function grokHomeFor(ctx: Pick<PrepareContext, 'mode' | 'homeDir' | 'processEnv' | 'userHome'>): string {
  if (ctx.mode === 'scoped') return path.join(ctx.homeDir, 'grok-home');
  return ctx.processEnv.GROK_HOME || path.join(ctx.userHome, '.grok');
}

/** 本地是否已有这个会话（续话前必须为真，否则 Grok 会进交互式登录挂住）。 */
export function grokSessionExists(runtimeFs: RuntimeFs, grokHome: string, workspace: string, sessionId: string): boolean {
  const sessions = path.join(grokHome, 'sessions');
  if (runtimeFs.exists(path.join(sessions, encodeURIComponent(workspace), sessionId))) return true;
  return runtimeFs.listDir(sessions).some((bucket) => runtimeFs.exists(path.join(sessions, bucket, sessionId)));
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function prepareGrokLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }];
  const launchEnv: Record<string, string> = { GROK_DISABLE_AUTOUPDATER: '1' };
  const args = ['--output-format', 'streaming-json', '--always-approve', '--no-auto-update'];
  const grokHome = grokHomeFor(ctx);
  let preamble = '';

  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const provider = request.provider;
    const userGrokHome = ctx.processEnv.GROK_HOME || path.join(ctx.userHome, '.grok');
    const userConfig = filterToml(ctx.fs.readText(path.join(userGrokHome, 'config.toml')) ?? '', { dropTopLevelKeys: OWNED_TOP_KEYS, dropSection: DROPPED_SECTION });
    const effort = provider.reasoningEffort ?? request.reasoningEffort;
    const lines: string[] = [];
    if (userConfig) lines.push(userConfig, '');
    lines.push(
      '[cli]',
      'auto_update = false',
      '',
      '[models]',
      `default = ${tomlString(GROK_MODEL_KEY)}`,
      `session_summary = ${tomlString(GROK_MODEL_KEY)}`,
    );
    if (effort && EFFORTS.has(effort)) lines.push(`default_reasoning_effort = ${tomlString(effort)}`);
    lines.push(
      '',
      `[model.${GROK_MODEL_KEY}]`,
      `model = ${tomlString(provider.model)}`,
      `name = ${tomlString(provider.model)}`,
      `base_url = ${tomlString(ctx.proxyTarget.responsesBaseUrl)}`,
      `env_key = ${tomlString(GROK_TOKEN_ENV)}`,
      `api_backend = ${tomlString('responses')}`,
      `context_window = ${provider.contextWindow ?? 128_000}`,
      `max_completion_tokens = ${provider.maxOutputTokens ?? 16_384}`,
    );
    const mcp = mcpServersToml(ctx.mcpServers, { startupTimeoutSec: 120 });
    if (mcp) lines.push('', mcp);

    const identity = [
      'Runtime model identity:',
      `- Grok Build is only the agent harness for this conversation; the model answering is "${provider.model}" served by provider "${provider.provider}".`,
      '- If asked which model you are, report that model id, not a Grok model.',
    ].join('\n');
    const userAgents = (ctx.fs.readText(path.join(userGrokHome, 'AGENTS.md')) ?? '').trim();
    const agents = [identity, userAgents, ctx.instructions ? managedPromptBlock(ctx.instructions) : ''].filter(Boolean).join('\n\n');

    files.push(
      { kind: 'dir', path: grokHome },
      { kind: 'file', path: path.join(grokHome, 'config.toml'), content: `${lines.join('\n')}\n` },
      { kind: 'file', path: path.join(grokHome, 'AGENTS.md'), content: `${agents}\n` },
      { kind: 'symlink', path: path.join(grokHome, 'skills'), target: path.join(userGrokHome, 'skills') },
    );
    launchEnv.GROK_HOME = grokHome;
    launchEnv[GROK_TOKEN_ENV] = ctx.proxyTarget.token;
    args.push('--model', GROK_MODEL_KEY);
    if (effort && EFFORTS.has(effort)) args.push('--reasoning-effort', effort);
  } else {
    if (request.model) args.push('--model', request.model);
    if (request.reasoningEffort && EFFORTS.has(request.reasoningEffort)) args.push('--reasoning-effort', request.reasoningEffort);
    if (ctx.instructions) {
      if (Buffer.byteLength(ctx.instructions, 'utf8') <= GROK_RULES_ARG_MAX_BYTES) args.push('--rules', ctx.instructions);
      else preamble = `${managedPromptBlock(ctx.instructions)}\n\n`;
    }
  }

  // 续话就绪判定：宁可新建，也不拿本地没有的 id 去 --resume。
  const candidate = ctx.resume.resumeNativeId ?? ctx.resume.createNativeId ?? request.sessionId;
  if (grokSessionExists(ctx.fs, grokHome, request.workspace, candidate)) args.push('--resume', candidate);
  else args.push('--session-id', candidate);

  const promptPath = path.join(homeDir, `turn-prompt-${ctx.runId}.md`);
  const text = ctx.command.kind === 'compact'
    ? `/compact${ctx.command.instructions?.trim() ? ` ${ctx.command.instructions.trim()}` : ''}`
    : `${preamble}${request.prompt}`;
  files.push({ kind: 'file', path: promptPath, content: text });
  args.push('--prompt-file', promptPath, '--cwd', request.workspace);

  return { files, args, launchEnv, stdin: 'ignore', cwd: request.workspace, cleanupPaths: [promptPath] };
}
