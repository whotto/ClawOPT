// 引导与健壮性提示的纯判据（壳层横幅用）：没有模型服务商、客户端版本过期。
// 判据集中在这里并带单测；组件只负责拿数据和画横幅。

/** 前端产物构建时嵌入的构建信息（vite `define` 注入，来自根目录 `.clawopt-build.json` 与 `package.json`）。 */
export type BuildIdentity = {
  version?: string | null;
  buildTime?: string | null;
};

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * 当前页面加载的前端产物是否与正在运行的服务端不是同一次构建。
 *
 * 不催刷新的情况（宁可漏报，不能天天误报——误报的「请刷新」会教会用户无视它）：
 * - 开发模式（vite dev 每次改动都在热更新，服务端构建信息与之无关）；
 * - 任何一侧缺构建时间（没跑 `version:meta` 的本地构建、读不到服务端版本）。
 * 两侧都有构建时间时，版本号或构建时间任一不同即为过期。
 */
export function isClientStale(client: BuildIdentity | null, server: BuildIdentity | null, options: { dev: boolean }): boolean {
  if (options.dev || !client || !server) return false;
  const clientBuild = text(client.buildTime);
  const serverBuild = text(server.buildTime);
  if (!clientBuild || !serverBuild) return false;
  if (clientBuild !== serverBuild) return true;
  const clientVersion = text(client.version);
  const serverVersion = text(server.version);
  return Boolean(clientVersion && serverVersion && clientVersion !== serverVersion);
}

export type NoProviderPrompt = 'hidden' | 'manage' | 'askAdmin';

export type NoProviderInputs = {
  /** `/api/models` 至少成功返回过一次。 */
  modelsLoaded: boolean;
  modelCount: number;
  /** 服务端读 openclaw.json 失败时回的空列表不代表「没配」，不能据此提示。 */
  modelsConfigReadFailed: boolean;
  /** `/api/runtime/member-runtimes` 已返回（失败也算返回，按「没有可用运行时」处理之外的情况见下）。 */
  runtimesLoaded: boolean;
  /** 本机可用（已安装）的外部编码运行时个数；拿不到时为 null，此时不提示。 */
  availableRuntimeCount: number | null;
  /** 能力清单已加载。 */
  capabilitiesLoaded: boolean;
  /** 当前用户能管理模型（`settings.models`）。 */
  canManageModels: boolean;
};

/**
 * 「还没有可用的模型服务商」提示：OpenClaw 一个模型都没配，且本机没有任何能直接对话的外部运行时。
 * 数据没到齐之前一律不显示（不闪一下再消失）；有权限的人给「去配置」，没权限的人给「请管理员配置」。
 */
export function resolveNoProviderPrompt(input: NoProviderInputs): NoProviderPrompt {
  if (!input.modelsLoaded || !input.runtimesLoaded || !input.capabilitiesLoaded) return 'hidden';
  if (input.modelsConfigReadFailed) return 'hidden';
  if (input.modelCount > 0) return 'hidden';
  if (input.availableRuntimeCount === null || input.availableRuntimeCount > 0) return 'hidden';
  return input.canManageModels ? 'manage' : 'askAdmin';
}

/** 版本检查的节奏：切回标签页 / 恢复连接最多每 10 分钟查一次，后台定时 15 分钟一次（`/api/version` 会调一次 openclaw --version）。 */
export const STALE_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;
export const STALE_CHECK_POLL_MS = 15 * 60 * 1000;

export function shouldRunStaleCheck(lastCheckedAt: number | null, now: number, force: boolean): boolean {
  if (force || lastCheckedAt === null) return true;
  return now - lastCheckedAt >= STALE_CHECK_MIN_INTERVAL_MS;
}
