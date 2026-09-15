/**
 * 子进程环境：白名单 + 启动环境，**不是**整个进程环境。
 *
 * 参考实现的最新提交把「合并好的整份环境」当成启动环境塞给每个隐藏运行，于是白名单形同虚设——
 * ClawOPT 进程里的任何变量（登录令牌的派生值、别家服务的 key）都会原样流进一个会执行模型生成命令的 CLI。
 * 这里的规矩：
 *
 * - **scoped**：白名单 + 启动环境（代理令牌、运行时 home 指针）。别的一概不给——
 *   包括 `ANTHROPIC_*` 这类「看起来有用」的：scoped 模式下它们只会让残留登录盖过代理。
 * - **global**：CLI 用自己的登录，所以额外放行这个运行时声明过的凭据变量（按名字模式），仍然不是整份环境。
 *
 * 平台的 `RuntimeManager.childEnv` 负责 PATH 合并；这里在它的结果上**再过一遍**名单——
 * 适配器不依赖管理器实现正确，守卫用例对着假管理器也能证明会红。
 */
import type { ProxyMode } from '../../contract';
import type { RuntimeManager } from '../_platform-types';

const ALLOWLIST_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows 系统变量（本仓库不在 Windows 上部署，但名单与参考实现保持一致，免得将来漏）
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
]);

export function isAllowlistedEnvName(name: string): boolean {
  return ALLOWLIST_EXACT.has(name) || name.startsWith('LC_') || /^ProgramFiles/.test(name);
}

export interface ChildEnvInput {
  mode: ProxyMode;
  manager: Pick<RuntimeManager, 'childEnv'>;
  /** 这一轮要设的变量（运行时 home、代理令牌…）。 */
  launchEnv: Record<string, string>;
  /** ClawOPT 进程自己的环境（测试注入）。 */
  processEnv: NodeJS.ProcessEnv;
  /** global 模式下放行的凭据变量名模式（运行时声明）。 */
  globalCredentialEnv: readonly RegExp[];
}

export function buildChildEnv(input: ChildEnvInput): NodeJS.ProcessEnv {
  const passthrough: Record<string, string> = {};
  if (input.mode === 'global') {
    for (const [name, value] of Object.entries(input.processEnv)) {
      if (typeof value === 'string' && input.globalCredentialEnv.some((re) => re.test(name))) passthrough[name] = value;
    }
  }
  const merged = input.manager.childEnv({ ...passthrough, ...input.launchEnv });
  const allowedExtra = new Set([...Object.keys(passthrough), ...Object.keys(input.launchEnv)]);
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if (isAllowlistedEnvName(name) || allowedExtra.has(name)) out[name] = value;
  }
  // 启动环境最后覆盖，保证运行时 home 与代理令牌不被管理器合并顺序吃掉。
  for (const [name, value] of Object.entries(input.launchEnv)) out[name] = value;
  return out;
}
