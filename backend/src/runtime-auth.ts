/**
 * 外接 Agent 的凭据状态。
 *
 * ## 这个模块换过一次数据源，原因值得留着
 *
 * v1.3.2 读的是 `openclaw models auth list`。**那是错的库**——
 * 理由写在 `acp-vendor-env.ts` 顶部，一句话：ACP 运行时跑的是厂商自己的 CLI，
 * 它读自己的凭据，不读 OpenClaw 的 auth-profiles。
 *
 * ## 为什么没有 `missing` 这个状态
 *
 * 这一版能确知的事只有一件：**我们写的那个 env 变量在不在**。
 *
 * 而「用户有没有在主机上用厂商 CLI 自己登录过」我们**无法可靠判断**——
 * 那要去猜 `~/.claude/`、`~/.gemini/` 之类的凭据文件路径，各家格式和位置
 * 都会变，猜错的表现是「已经登录了却显示未登录」。
 *
 * 所以状态只有两个：
 *
 * - `configured` —— 我们写的 key 在（**事实**）
 * - `unknown` —— 我们没写 key；厂商 CLI 可能已在主机上登录过，我们看不见
 *
 * 少一个状态是有意的。上一版正是因为敢说「未登录」而说了假话；
 * 一个不敢乱说的界面，比一个自信说错的界面有用。
 */
import { VENDOR_ENV_KEY, readVendorEnvNames } from './acp-vendor-env';
import { AGENT_RUNTIMES, type AgentRuntimeId } from './agent-runtimes';

export type RuntimeAuthState =
  /** 引擎自己跑，不需要外部凭据。 */
  | 'notRequired'
  /** 我们写的 env key 在。 */
  | 'configured'
  /** 我们没写 key。厂商 CLI 可能已在主机登录，我们无从判断。 */
  | 'unknown'
  /** `.env` 读不出来（权限、坏文件）。与「没配」区分开。 */
  | 'unreadable';

export type RuntimeAuthRow = {
  readonly runtimeId: AgentRuntimeId;
  /** 这个运行时认哪个环境变量。`null` = 网页端配不了，只能在主机上登录。 */
  readonly envKey: string | null;
  readonly state: RuntimeAuthState;
  /** 网页端能不能填。`false` 时界面必须说清楚为什么，而不是给个灰按钮。 */
  readonly webConfigurable: boolean;
};

/**
 * 读出每个运行时的状态。
 *
 * 同步、不起进程。上一版为此 fork 一个 Node 跑 CLI，在 330MB 内存的生产机上
 * 是实打实的开销，而且要 15 秒超时兜底；现在读一个文件就够。
 */
export function readRuntimeAuthStatus(): RuntimeAuthRow[] {
  const names = readVendorEnvNames();

  return AGENT_RUNTIMES.map((runtime) => {
    const envKey = VENDOR_ENV_KEY[runtime.id];

    if (runtime.requires === null) {
      return { runtimeId: runtime.id, envKey: null, state: 'notRequired' as const, webConfigurable: false };
    }
    if (envKey === null) {
      // 需要凭据，但文档里没有对应的环境变量（当前是 Pi）。
      // 不假装能配——界面要说「只能在主机上登录」。
      return { runtimeId: runtime.id, envKey: null, state: 'unknown' as const, webConfigurable: false };
    }
    if (names === null) {
      return { runtimeId: runtime.id, envKey, state: 'unreadable' as const, webConfigurable: true };
    }
    return {
      runtimeId: runtime.id,
      envKey,
      state: names.has(envKey) ? ('configured' as const) : ('unknown' as const),
      webConfigurable: true,
    };
  });
}
