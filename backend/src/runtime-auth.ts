/**
 * 运行时账号状态：每个外部运行时有没有登录。
 *
 * ## 为什么只读不写
 *
 * Gateway 的 WS 协议里 `models.*` 共十个方法，有 `models.authStatus` 与
 * `models.authLogout`，**没有 `authLogin`**。登录只有 CLI 一条路
 * （`openclaw models auth login --provider X --device-code`）。
 *
 * 所以这个模块能做的是「告诉用户现在是什么状态、该敲什么命令」，
 * **不是「替他登录」**。把它做成「点一下、背后偷偷 ssh 执行命令」会要求
 * ClawOPT 拿到主机 shell 权限——比现在大得多的攻击面，而且用户看不见发生了什么。
 *
 * ## 数据源：CLI 的 `--json`，不是解析人类可读文本
 *
 * `openclaw models auth list --json` 有结构化输出。解析表格文本会在上游
 * 改一次排版时静默失效，而那种失效的表现是「所有运行时都显示未登录」——
 * 用户会去重新登录一个本来就登录着的账号。
 */
import { execFile } from 'child_process';
import { AGENT_RUNTIMES, type AgentRuntimeId } from './agent-runtimes';

export type RuntimeAuthState = 'authenticated' | 'missing' | 'unknown';

export type RuntimeAuthRow = {
  readonly runtimeId: AgentRuntimeId;
  /** 这个运行时需要哪个 provider 的账号。`null` = 不需要（引擎自己跑）。 */
  readonly provider: string | null;
  readonly state: RuntimeAuthState;
  /** 已登录时的 profile 标签，供用户分辨多账号。 */
  readonly profiles: readonly string[];
  /** 该敲的命令。**原样给出，让用户自己执行**——我们不代劳。 */
  readonly loginCommand: string | null;
};

/** 探测超时。CLI 起进程要几秒，但不能让一个卡住的 CLI 把接口拖死。 */
const PROBE_TIMEOUT_MS = 15_000;

function runOpenclawJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('openclaw', args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      // CLI 会在 JSON 之前打配置告警，取第一个 `{` 之后的部分。
      const text = String(stdout);
      const start = text.indexOf('{');
      if (start < 0) return reject(new Error('no json in output'));
      try {
        resolve(JSON.parse(text.slice(start)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * 读出每个运行时的登录状态。
 *
 * **探测失败时返回 `unknown`，不返回 `missing`。** 两者对用户是完全不同的
 * 指示：`missing` 说「去登录」，`unknown` 说「我不知道，你自己看一眼」。
 * 把「问不出来」显示成「没登录」，会让用户去重新登录一个本来就好的账号——
 * 而 `--force` 登录会删掉现有 profile。
 */
export async function readRuntimeAuthStatus(agentId = 'main'): Promise<RuntimeAuthRow[]> {
  let profilesByProvider: Map<string, string[]> | null = null;

  try {
    const data = await runOpenclawJson(['models', 'auth', 'list', '--agent', agentId, '--json']);
    const list = (data as { profiles?: unknown })?.profiles;
    if (Array.isArray(list)) {
      profilesByProvider = new Map();
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const provider = (item as Record<string, unknown>).provider;
        const label = (item as Record<string, unknown>).label;
        if (typeof provider !== 'string') continue;
        const bucket = profilesByProvider.get(provider) ?? [];
        bucket.push(typeof label === 'string' ? label : provider);
        profilesByProvider.set(provider, bucket);
      }
    }
  } catch (error) {
    // 探测不到就是 unknown。出声，但不要把原始错误抛给界面——
    // 它可能带主机路径。
    console.warn(
      `[runtime-auth] 读取登录状态失败（${(error as NodeJS.ErrnoException)?.code ?? 'unknown'}），状态显示为未知`,
    );
  }

  return AGENT_RUNTIMES.map((runtime) => {
    const provider = runtime.requires;
    if (!provider) {
      return { runtimeId: runtime.id, provider: null, state: 'authenticated' as const, profiles: [], loginCommand: null };
    }
    if (!profilesByProvider) {
      return {
        runtimeId: runtime.id,
        provider,
        state: 'unknown' as const,
        profiles: [],
        loginCommand: buildLoginCommand(provider),
      };
    }
    const profiles = profilesByProvider.get(provider) ?? [];
    return {
      runtimeId: runtime.id,
      provider,
      state: profiles.length > 0 ? ('authenticated' as const) : ('missing' as const),
      profiles,
      loginCommand: profiles.length > 0 ? null : buildLoginCommand(provider),
    };
  });
}

/**
 * 登录命令。**统一带 `--device-code`**：ClawOPT 装在远程主机上，
 * 默认的浏览器回调流程在那儿走不通（没有浏览器、localhost 回调到不了用户机器）。
 * 设备码流程让用户在自己的浏览器里授权，凭据由 provider 直接发给主机。
 */
export function buildLoginCommand(provider: string): string {
  return `openclaw models auth login --provider ${provider} --device-code`;
}
