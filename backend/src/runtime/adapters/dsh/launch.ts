/**
 * DSH 的启动准备。
 *
 * 两种模式：`dsh --profile acp`，`DSH_PERMISSION_MODE=danger-full-access`，`DSH_TELEMETRY_DISABLED=1`，stdin 留给 ACP。
 * ACP 没有系统提示参数：
 * - scoped：指令写进运行时 DSH_HOME 的 AGENTS.md（DSH 从 home 读）；
 * - global：不改用户的 ~/.dsh，指令作为本轮 prompt 的第一个文本块（托管块包着）。
 *
 * scoped：DSH_HOME = `<运行时 home>/dsh-home`：
 *   - settings.yaml 只放一个服务商 `clawopt`（`llm-pi-ai.providers`，api: openai-responses，baseURL 指向代理，
 *     `apiKeyEnv: CLAWOPT_DSH_API_KEY`——凭据引用，不是 key）；
 *   - `clawopt-acp.patch.yml` 把 `acp` 这一行的默认路由指到 `clawopt/<模型>`，经 `--patch` 叠加；
 *   - 用户的 skills 目录软链共享；AGENTS.md = 用户的 + 托管块。
 */
import path from 'path';
import type { PrepareContext, PreparedLaunch } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { PlannedFile } from '../_shared/runtime-fs';

export const DSH_PROVIDER_ID = 'clawopt';
export const DSH_TOKEN_ENV = 'CLAWOPT_DSH_API_KEY';
export const DSH_PATCH_FILE = 'clawopt-acp.patch.yml';

const DSH_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

/** ClawOPT 推理强度 → DSH 档位：max → xhigh，none → off。 */
export function dshEffort(effort: string | undefined): string | null {
  if (!effort || effort === 'default') return null;
  const mapped = effort === 'max' ? 'xhigh' : effort === 'none' ? 'off' : effort;
  return DSH_EFFORTS.has(mapped) ? mapped : null;
}

/** YAML 双引号标量：JSON 字符串转义是它的子集。 */
const yamlString = (value: string) => JSON.stringify(value);

export function prepareDshLaunch(ctx: PrepareContext): PreparedLaunch {
  const { request, homeDir } = ctx;
  const files: PlannedFile[] = [{ kind: 'dir', path: homeDir }];
  const launchEnv: Record<string, string> = { DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1' };
  const args = ['--profile', 'acp'];

  if (ctx.mode === 'scoped' && request.provider && ctx.proxyTarget) {
    const provider = request.provider;
    const dshHome = path.join(homeDir, 'dsh-home');
    const userDshHome = ctx.processEnv.DSH_HOME || path.join(ctx.userHome, '.dsh');
    const effort = dshEffort(provider.reasoningEffort ?? request.reasoningEffort);
    const settings = [
      'llm-pi-ai:',
      '  providers:',
      `    ${DSH_PROVIDER_ID}:`,
      `      displayName: ${yamlString(provider.provider)}`,
      `      apiKeyEnv: ${DSH_TOKEN_ENV}`,
      '      api: openai-responses',
      `      baseURL: ${yamlString(ctx.proxyTarget.responsesBaseUrl)}`,
      '      models:',
      `        - id: ${yamlString(provider.model)}`,
      `          contextWindow: ${provider.contextWindow ?? 128_000}`,
      `          maxTokens: ${provider.maxOutputTokens ?? 8_192}`,
      ...(effort ? ['          reasoningEfforts:', `            ${effort}: ${effort}`] : []),
    ].join('\n');
    const patch = [
      '- id: acp',
      '  config:',
      `    provider: ${DSH_PROVIDER_ID}`,
      `    model: ${yamlString(provider.model)}`,
    ].join('\n');
    const userAgents = (ctx.fs.readText(path.join(userDshHome, 'AGENTS.md')) ?? '').trim();
    const agents = [userAgents, ctx.instructions ? managedPromptBlock(ctx.instructions) : ''].filter(Boolean).join('\n\n');
    const patchPath = path.join(homeDir, DSH_PATCH_FILE);
    files.push(
      { kind: 'dir', path: dshHome },
      { kind: 'file', path: path.join(dshHome, 'settings.yaml'), content: `${settings}\n` },
      { kind: 'file', path: patchPath, content: `${patch}\n` },
      { kind: 'symlink', path: path.join(dshHome, 'skills'), target: path.join(userDshHome, 'skills') },
    );
    if (agents) files.push({ kind: 'file', path: path.join(dshHome, 'AGENTS.md'), content: `${agents}\n` });
    launchEnv.DSH_HOME = dshHome;
    launchEnv[DSH_TOKEN_ENV] = ctx.proxyTarget.token;
    args.push('--patch', patchPath);
  }

  return { files, args, launchEnv, stdin: 'pipe', cwd: request.workspace };
}
