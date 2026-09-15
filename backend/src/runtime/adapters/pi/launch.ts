/**
 * Pi 的启动准备。
 *
 * 两种模式都：`--mode rpc --session-id <id> --session-dir <运行时 home>/sessions --no-approve --offline`，
 * 本轮指令写进 `<home>/APPEND_SYSTEM.md` 经 `--append-system-prompt <文件>` 传入（Pi 支持「文本或文件内容」）。
 *
 * 与 spec 的偏离：spec 用一个运行时扩展在 `before_agent_start` 里读「动态提示文件」，因为它的 Pi 进程跨轮存活；
 * 我们每轮一个新进程，指令文件每轮重写就够了，不必往用户的 Pi 里装一段扩展代码。
 *
 * scoped：PI_CODING_AGENT_DIR = `<home>/pi-agent`：
 *   - `models.json` 注册服务商 `clawopt`（`api: openai-responses`，baseUrl 指向代理），
 *     `apiKey: "$CLAWOPT_PI_API_KEY"`——Pi 的 models.json 支持环境变量插值，令牌不进文件；
 *   - `settings.json` = 用户设置去掉 packages / extensions（换了 agent 目录，相对路径会失效）；
 *   - 用户的 `extensions/`、`skills/`、`prompts/` 以软链共享（只读用，不往里写）。
 */
import path from 'path';
import type { PrepareContext, PreparedLaunch } from '../_shared/cli-adapter';
import type { PlannedFile } from '../_shared/runtime-fs';

export const PI_PROVIDER_ID = 'clawopt';
export const PI_TOKEN_ENV = 'CLAWOPT_PI_API_KEY';
export const PI_APPEND_SYSTEM_FILE = 'APPEND_SYSTEM.md';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** ClawOPT 的推理强度 → Pi 的 thinking level；default / 空 → 不设。 */
export function piThinkingLevel(effort: string | undefined): string | null {
  if (!effort || effort === 'default') return null;
  const mapped = effort === 'none' ? 'off' : effort === 'ultra' ? 'max' : effort;
  return THINKING_LEVELS.has(mapped) ? mapped : null;
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

export function preparePiLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const sessionsDir = path.join(homeDir, 'sessions');
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }, { kind: 'dir', path: sessionsDir }];
  const nativeId = ctx.resume.resumeNativeId ?? ctx.resume.createNativeId ?? request.sessionId;
  const args = ['--mode', 'rpc', '--session-id', nativeId, '--session-dir', sessionsDir, '--no-approve', '--offline'];
  const launchEnv: Record<string, string> = { PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1' };

  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const provider = request.provider;
    const agentDir = path.join(homeDir, 'pi-agent');
    const userAgentDir = ctx.processEnv.PI_CODING_AGENT_DIR || path.join(ctx.userHome, '.pi', 'agent');
    const userSettings = readJsonObject(ctx, path.join(userAgentDir, 'settings.json'));
    delete userSettings.packages;
    delete userSettings.extensions;
    const effort = piThinkingLevel(provider.reasoningEffort ?? request.reasoningEffort);
    const reasoning = Boolean(effort && effort !== 'off');
    const models = {
      providers: {
        [PI_PROVIDER_ID]: {
          baseUrl: ctx.proxyTarget.responsesBaseUrl,
          apiKey: `$${PI_TOKEN_ENV}`,
          api: 'openai-responses',
          models: [{
            id: provider.model,
            name: provider.model,
            reasoning,
            ...(reasoning ? { thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } } : {}),
            input: ['text', 'image'],
            contextWindow: provider.contextWindow ?? 128_000,
            maxTokens: provider.maxOutputTokens ?? 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          }],
        },
      },
    };
    files.push(
      { kind: 'dir', path: agentDir },
      { kind: 'file', path: path.join(agentDir, 'models.json'), content: `${JSON.stringify(models, null, 2)}\n` },
      { kind: 'file', path: path.join(agentDir, 'settings.json'), content: `${JSON.stringify(userSettings, null, 2)}\n` },
    );
    for (const shared of ['extensions', 'skills', 'prompts']) {
      files.push({ kind: 'symlink', path: path.join(agentDir, shared), target: path.join(userAgentDir, shared) });
    }
    launchEnv.PI_CODING_AGENT_DIR = agentDir;
    launchEnv[PI_TOKEN_ENV] = ctx.proxyTarget.token;
    args.push('--provider', PI_PROVIDER_ID, '--model', provider.model);
  } else if (request.model) {
    args.push('--model', request.model);
  }

  if (ctx.instructions) {
    const appendPath = path.join(homeDir, PI_APPEND_SYSTEM_FILE);
    files.push({ kind: 'file', path: appendPath, content: `${ctx.instructions}\n` });
    args.push('--append-system-prompt', appendPath);
  }

  return { files, args, launchEnv, stdin: 'pipe', cwd: request.workspace };
}
