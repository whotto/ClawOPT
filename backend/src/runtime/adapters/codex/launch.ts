/**
 * Codex 的启动准备。
 *
 * global：**用用户自己的 CODEX_HOME，不做影子 home**——这是与 spec 的有意偏离。
 *   spec 把 `auth.json` 拷进影子 home 让原生登录生效；但本机实测登录是 ChatGPT OAuth（带 refresh_token），
 *   影子副本一旦自己刷新了令牌，上游轮换 refresh_token 后用户真实的 `~/.codex/auth.json` 就失效——
 *   等于替用户登出。所以 global 模式只经 `-c` 覆盖注入指令与 MCP，不碰用户的 home。
 *   代价：原生会话记录写在用户自己的 `~/.codex/sessions` 里（本来就是用户的 CLI 在跑）。
 * scoped：CODEX_HOME = 运行时 home 下的 `codex-home/`，生成 config.toml：
 *   用户的 config.toml 去掉运行时自己管的键与段 → 自定义 provider（wire_api="responses"，base_url 指向代理）
 *   → 令牌经 `env_key` 从进程环境读，**不写进文件**（spec 用 experimental_bearer_token 写进了文件）。
 */
import path from 'path';
import type { PrepareContext, PreparedLaunch } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { PlannedFile } from '../_shared/runtime-fs';
import { filterToml, mcpServerTable, mcpServersToml, safeMcpName, tomlString, tomlValue } from '../_shared/toml';

export const CODEX_PROVIDER_ID = 'clawopt';
export const CODEX_TOKEN_ENV = 'CLAWOPT_CODEX_API_KEY';

const RUNTIME_OWNED_KEYS = new Set([
  'model', 'model_provider', 'model_catalog_json', 'model_reasoning_summary', 'model_reasoning_effort',
  'developer_instructions', 'disable_response_storage', 'experimental_bearer_token', 'forced_login_method',
  'preferred_auth_method', 'chatgpt_base_url',
]);

const DROPPED_SECTION = (header: string) =>
  header === 'models' || header.startsWith('model.') || header === 'model_providers' || header.startsWith('model_providers.')
  || header === 'mcp_servers' || header.startsWith('mcp_servers.') || header.startsWith('auth') || header.startsWith('account');

export function filterUserCodexConfig(text: string): string {
  return filterToml(text, { dropTopLevelKeys: RUNTIME_OWNED_KEYS, dropSection: DROPPED_SECTION });
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** 两种模式、两种命令（exec 一轮 / app-server 压缩）共用的 `-c` 覆盖。 */
function commonOverrides(ctx: PrepareContext): string[] {
  const args: string[] = ['-c', `model_reasoning_summary=${tomlString('auto')}`];
  const effort = ctx.request.provider?.reasoningEffort ?? ctx.request.reasoningEffort;
  if (effort && EFFORTS.has(effort)) args.push('-c', `model_reasoning_effort=${tomlString(effort)}`);
  if (ctx.mode === 'global') {
    if (ctx.instructions) args.push('-c', `developer_instructions=${tomlString(ctx.instructions)}`);
    for (const server of ctx.mcpServers) {
      args.push('-c', `mcp_servers.${safeMcpName(server.name)}=${tomlValue(mcpServerTable(server, { startupTimeoutSec: 120 }))}`);
    }
    if (ctx.request.model) args.push('-m', ctx.request.model);
  }
  return args;
}

export function prepareCodexLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }];
  const launchEnv: Record<string, string> = {};

  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const provider = request.provider;
    const codexHome = path.join(homeDir, 'codex-home');
    const userCodexHome = ctx.processEnv.CODEX_HOME || path.join(ctx.userHome, '.codex');
    const userConfig = filterUserCodexConfig(ctx.fs.readText(path.join(userCodexHome, 'config.toml')) ?? '');
    const userAgents = (ctx.fs.readText(path.join(userCodexHome, 'AGENTS.override.md')) ?? '').trim()
      || (ctx.fs.readText(path.join(userCodexHome, 'AGENTS.md')) ?? '').trim();
    const developer = [ctx.instructions, userAgents].filter(Boolean).join('\n\n');

    // TOML 里顶层键必须在第一个表头之前：用户配置拆成「顶层键」与「表」两段，我们的顶层键插在中间。
    const firstHeader = userConfig.search(/^\s*\[/m);
    const userTop = (firstHeader < 0 ? userConfig : userConfig.slice(0, firstHeader)).trim();
    const userTables = firstHeader < 0 ? '' : userConfig.slice(firstHeader).trim();
    const lines: string[] = [];
    if (userTop) lines.push(userTop);
    lines.push(
      `model_provider = ${tomlString(CODEX_PROVIDER_ID)}`,
      `model = ${tomlString(provider.model)}`,
      `model_reasoning_summary = ${tomlString('auto')}`,
    );
    if (developer) lines.push(`developer_instructions = ${tomlString(developer)}`);
    if (userTables) lines.push('', userTables);
    lines.push(
      '',
      `[model_providers.${CODEX_PROVIDER_ID}]`,
      `name = ${tomlString(provider.provider)}`,
      `base_url = ${tomlString(ctx.proxyTarget.responsesBaseUrl)}`,
      `wire_api = ${tomlString('responses')}`,
      `env_key = ${tomlString(CODEX_TOKEN_ENV)}`,
      'requires_openai_auth = false',
    );
    const mcp = mcpServersToml(ctx.mcpServers, { startupTimeoutSec: 120 });
    if (mcp) lines.push('', mcp);

    files.push(
      { kind: 'dir', path: codexHome },
      { kind: 'file', path: path.join(codexHome, 'config.toml'), content: `${lines.join('\n')}\n` },
      { kind: 'file', path: path.join(codexHome, 'AGENTS.md'), content: `${ctx.instructions ? `${managedPromptBlock(ctx.instructions)}\n\n` : ''}${userAgents ? `${userAgents}\n` : ''}` },
    );
    launchEnv.CODEX_HOME = codexHome;
    launchEnv[CODEX_TOKEN_ENV] = ctx.proxyTarget.token;
  }

  if (ctx.command.kind === 'compact') {
    // 压缩：app-server JSON-RPC；驱动负责 initialize / resume / compact。
    return {
      files,
      args: ['app-server', ...commonOverrides(ctx)],
      launchEnv,
      stdin: 'pipe',
      cwd: request.workspace,
    };
  }

  const tail = ['--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
  for (const image of request.images ?? []) tail.push('--image', image.path);
  const args = ctx.resume.resumeNativeId
    ? ['exec', 'resume', '--json', ...commonOverrides(ctx), ...tail, ctx.resume.resumeNativeId, '-']
    : ['exec', '--json', ...commonOverrides(ctx), ...tail, '--cd', request.workspace, '-'];

  return { files, args, launchEnv, stdin: 'pipe', stdinData: `${request.prompt}\n`, cwd: request.workspace };
}
