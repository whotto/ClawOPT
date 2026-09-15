/**
 * 网关状态卡：`openclaw gateway status --json` 的「旧数据先回、后台再刷」缓存。
 *
 * 这条命令要探 RPC、查端口、问服务管理器，冷启 2–4 秒。界面每几秒轮询一次时，
 * 每次都现跑一遍会让轮询互相叠加。规则（spec 05 F24 的形状）：
 *
 * - 有缓存就立刻返回缓存 + `refreshing` 标志；缓存比 `staleMs` 旧时顺手触发一次后台刷新；
 * - `refresh=true` 一定触发刷新；刷新进行中再来的请求**合并**：本轮结束后最多再补跑一轮；
 * - 没有任何缓存时等第一次刷新完成再返回（首屏不给一个空壳）。
 */
import { OpenClawCliError, type OpenClawCliRunner } from '../../openclaw';

type Raw = Record<string, unknown>;

export type GatewayStatusSummary = {
  cliVersion: string | null;
  gatewayVersion: string | null;
  bindMode: string | null;
  port: number | null;
  serviceLoaded: boolean | null;
  serviceRuntime: string | null;
  rpcOk: boolean | null;
  rpcCapability: string | null;
  portBusy: boolean | null;
};

export type GatewayStatusSnapshot = {
  summary: GatewayStatusSummary | null;
  errorCode: string | null;
  updatedAt: number | null;
  refreshing: boolean;
};

const obj = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function summarizeGatewayStatus(raw: Raw): GatewayStatusSummary {
  const cli = obj(raw.cli);
  const gateway = obj(raw.gateway);
  const service = obj(raw.service);
  const runtime = obj(service.runtime);
  const rpc = obj(raw.rpc);
  const port = obj(raw.port);
  return {
    cliVersion: str(cli.version),
    gatewayVersion: str(gateway.version) ?? str(rpc.version),
    bindMode: str(gateway.bindMode),
    port: typeof gateway.port === 'number' ? gateway.port : null,
    serviceLoaded: typeof service.loaded === 'boolean' ? service.loaded : null,
    serviceRuntime: str(runtime.status),
    rpcOk: typeof rpc.ok === 'boolean' ? rpc.ok : null,
    rpcCapability: str(rpc.capability),
    portBusy: typeof port.status === 'string' ? port.status === 'busy' : null,
  };
}

export function createGatewayStatusCache(deps: { openclawCli: OpenClawCliRunner; now?: () => number; staleMs?: number }) {
  const now = deps.now ?? Date.now;
  const staleMs = deps.staleMs ?? 15_000;
  let snapshot: Omit<GatewayStatusSnapshot, 'refreshing'> = { summary: null, errorCode: null, updatedAt: null };
  let inflight: Promise<void> | null = null;
  let rerunRequested = false;

  async function refreshOnce(): Promise<void> {
    try {
      const raw = await deps.openclawCli.runJson<Raw>(['gateway', 'status', '--json'], { timeoutMs: 30_000 });
      snapshot = { summary: summarizeGatewayStatus(raw), errorCode: null, updatedAt: now() };
    } catch (error) {
      // 刷新失败不抹掉上一份好数据：界面继续显示旧状态 + 错误码。
      snapshot = { ...snapshot, errorCode: error instanceof OpenClawCliError ? error.errorCode : 'gateway.statusFailed', updatedAt: now() };
    }
  }

  function scheduleRefresh(): Promise<void> {
    if (inflight) {
      rerunRequested = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        rerunRequested = false;
        await refreshOnce();
      } while (rerunRequested);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function get(options: { refresh?: boolean } = {}): Promise<GatewayStatusSnapshot> {
    const stale = snapshot.updatedAt === null || now() - snapshot.updatedAt > staleMs;
    if (options.refresh || stale) {
      const pending = scheduleRefresh();
      if (snapshot.updatedAt === null) await pending;
    }
    return { ...snapshot, refreshing: inflight !== null };
  }

  function invalidate(): void {
    void scheduleRefresh();
  }

  return { get, invalidate };
}

export type GatewayStatusCache = ReturnType<typeof createGatewayStatusCache>;
