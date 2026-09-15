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
import { isAllowlistedEnvName } from '../../manager/path-env';
import type { RuntimeManager } from '../../manager/types';

/** 名单只有一份：运行时管理器的 `CHILD_ENV_ALLOWLIST`（含 `LC_*`）。 */
export { isAllowlistedEnvName };

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

/**
 * ClawOPT 自己的变量（登录令牌、数据目录、它自己用的上游 key…）**任何模式都不放行**。
 * 运行时的凭据模式是按名字形状写的（`_AUTH_TOKEN$`、`_API_KEY$`），不排除的话 `CLAWOPT_AUTH_TOKEN` 会顺着它漏出去
 * （集成 P2 时守卫第一次跑就抓到了 pi / opencode / dsh / hermes 四个）。适配器自己在启动环境里设的 `CLAWOPT_*`（代理令牌）不受影响。
 */
const NEVER_INHERITED = /^CLAWOPT_/i;

export function buildChildEnv(input: ChildEnvInput): NodeJS.ProcessEnv {
  const passthrough: Record<string, string> = {};
  if (input.mode === 'global') {
    for (const [name, value] of Object.entries(input.processEnv)) {
      if (typeof value !== 'string' || NEVER_INHERITED.test(name)) continue;
      if (input.globalCredentialEnv.some((re) => re.test(name))) passthrough[name] = value;
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
