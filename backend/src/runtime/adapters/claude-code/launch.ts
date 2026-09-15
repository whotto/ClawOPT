/**
 * Claude Code 的启动准备：文件、参数、环境。纯函数（只读用户 home 下的 settings.json），金样用例直接比结果。
 *
 * global：运行时 home 只放托管指令文件（与 mcp.json）；CLI 用自己的登录与配置。
 * scoped：
 *   1. 继承用户 `~/.claude/settings.json`，**删掉**会盖过代理的认证项：`apiKeyHelper`、`awsAuthRefresh`、
 *      `awsCredentialExport`、`forceLoginMethod`，以及 env 里所有 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN`、
 *      `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`——残留的 OAuth 登录会静默赢过代理；
 *   2. 运行时 settings.json 写代理地址、全部模型别名指到选定模型（子 Agent 与快速路径也用它）、
 *      自动压缩窗口按 ClawOPT 的上下文长度、阈值 50%；
 *   3. 代理令牌**只进进程环境**（`ANTHROPIC_API_KEY`），不进任何文件——比参考实现更严：它把令牌写进了 settings.json；
 *   4. `--settings <文件> --setting-sources local`：用户 / 项目级设置不再覆盖。
 */
import path from 'path';
import type { ManagedMcpServer } from '../_platform-types';
import type { PrepareContext, PreparedLaunch } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { PlannedFile } from '../_shared/runtime-fs';

export const CLAUDE_RULES_FILE = 'clawopt-rules.md';
export const CLAUDE_MCP_FILE = 'mcp.json';
export const CLAUDE_SETTINGS_FILE = 'settings.json';

const STRIPPED_SETTINGS_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod'];
const STRIPPED_ENV_EXACT = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);

/** 继承的用户设置里去掉认证相关项。 */
export function scrubInheritedClaudeSettings(settings: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...settings };
  for (const key of STRIPPED_SETTINGS_KEYS) delete out[key];
  if (out.env && typeof out.env === 'object') {
    const env: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(out.env as Record<string, unknown>)) {
      if (name.startsWith('ANTHROPIC_') || STRIPPED_ENV_EXACT.has(name)) continue;
      env[name] = value;
    }
    out.env = env;
  }
  return out;
}

export function claudeMcpConfig(servers: readonly ManagedMcpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    mcpServers[server.name] = server.transport === 'http'
      ? { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
      : { type: 'stdio', command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) };
  }
  return { mcpServers };
}

/** 显示名：模型 id 最后一段，按段首字母大写。 */
export function modelDisplayName(model: string): string {
  const last = model.split('/').filter(Boolean).pop() ?? model;
  return last.split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function readJsonObject(ctx: PrepareContext, filePath: string): Record<string, any> {
  const text = ctx.fs.readText(filePath);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function prepareClaudeCodeLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }];
  const args: string[] = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompts', 'none',
  ];
  const launchEnv: Record<string, string> = {};

  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const provider = request.provider;
    const model = provider.model;
    const display = modelDisplayName(model);
    const inherited = scrubInheritedClaudeSettings(readJsonObject(ctx, path.join(ctx.userHome, '.claude', 'settings.json')));
    const contextWindow = provider.contextWindow ?? 128_000;
    const managedEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: ctx.proxyTarget.anthropicBaseUrl,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION: model,
      ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: display,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: display,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: display,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: display,
      // Claude 不知道非 Anthropic 模型的真实窗口，会压缩得太晚，撞上代理的请求体上限。
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      ENABLE_TOOL_SEARCH: 'true',
    };
    const settingsPath = path.join(homeDir, CLAUDE_SETTINGS_FILE);
    const env = { ...(inherited.env ?? {}), ...managedEnv };
    files.push({ kind: 'file', path: settingsPath, content: `${JSON.stringify({ ...inherited, model, env }, null, 2)}\n` });
    // 进程环境只放托管的那几项（继承的 env 由 CLI 从 settings.json 自己读）。
    Object.assign(launchEnv, managedEnv);
    // 令牌只在进程环境里。
    launchEnv.ANTHROPIC_API_KEY = ctx.proxyTarget.token;
    args.push('--settings', settingsPath, '--setting-sources', 'local', '--model', model);
    const effort = provider.reasoningEffort ?? request.reasoningEffort;
    if (effort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);
  } else {
    if (request.model) args.push('--model', request.model);
    if (request.reasoningEffort && ['low', 'medium', 'high', 'xhigh', 'max'].includes(request.reasoningEffort)) {
      args.push('--effort', request.reasoningEffort);
    }
  }

  if (ctx.mcpServers.length > 0) {
    const mcpPath = path.join(homeDir, CLAUDE_MCP_FILE);
    files.push({ kind: 'file', path: mcpPath, content: `${JSON.stringify(claudeMcpConfig(ctx.mcpServers), null, 2)}\n` });
    args.push('--mcp-config', mcpPath);
  }

  if (ctx.instructions) {
    const rulesPath = path.join(homeDir, CLAUDE_RULES_FILE);
    files.push({ kind: 'file', path: rulesPath, content: `${managedPromptBlock(ctx.instructions)}\n` });
    args.push('--append-system-prompt-file', rulesPath);
  }

  if (ctx.resume.resumeNativeId) args.push('--resume', ctx.resume.resumeNativeId);
  else if (ctx.resume.createNativeId) args.push('--session-id', ctx.resume.createNativeId);

  if (request.allowedTools?.length) args.push('--allowedTools', ...request.allowedTools);
  for (const dir of request.extraDirs ?? []) args.push('--add-dir', dir);
  if (typeof request.maxBudgetUsd === 'number') args.push('--max-budget-usd', String(request.maxBudgetUsd));

  const text = ctx.command.kind === 'compact'
    ? `/compact${ctx.command.instructions?.trim() ? ` ${ctx.command.instructions.trim()}` : ''}`
    : request.prompt;
  const images = ctx.command.kind === 'turn' ? (request.images ?? []).filter((image) => image.data) : [];

  let stdinData: string;
  if (images.length > 0) {
    args.push('--input-format', 'stream-json');
    const content: unknown[] = [];
    if (text) content.push({ type: 'text', text });
    for (const image of images) {
      const mediaType = image.mimeType === 'image/jpg' ? 'image/jpeg' : (image.mimeType || 'image/png');
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: image.data } });
    }
    stdinData = `${JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null })}\n`;
  } else {
    // prompt 一律走 stdin：不受 ARG_MAX 限制，也不出现在 `ps` 里。
    args.push('--input-format', 'text');
    stdinData = `${text}\n`;
  }

  return { files, args, launchEnv, stdin: 'pipe', stdinData, cwd: request.workspace };
}
