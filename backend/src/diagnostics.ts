/**
 * 诊断快照：把「现场」压成一份能一键复制的 JSON。
 *
 * 排障场景是「用户在自己的主机上，我们看不见」。此前能拿到的只有一句截图，
 * 而 CHANGELOG 里几乎每条修复都写着「真机上才看得见」。
 *
 * 三条纪律，都是从既有事故里搬过来的：
 *
 * 1. **读不到 ≠ 没有。** 引擎版本探不到就报 `null` + 原因，不猜一个具体版本
 *    （`openclaw-version.ts` 为这条写过整整一批用例）；配置读不动就标
 *    `configReadFailed`，不报告一个「0 个 Agent」的假象（v1.2.4 修的就是这个）。
 * 2. **任何一块采集失败都不能让整份报告塌掉。** 排障工具在故障现场崩掉等于没有。
 * 3. **整份报告过一遍脱敏再返回。** 它从 HTTP 出去，且天然带工作区绝对路径
 *    （含用户名）。v1.2.3 修过「报错把凭据带进响应体」，这里不能换个出口重开。
 */
import { getCurrentAppVersionInfo } from './app-version';
import { resolveRosterShape, listRosterEntries } from './agents-roster';
import { sanitizeErrorDetail } from './openclaw-config';
import { recentLogEntries, redactLogValue, type LogEntry } from './logger';
import type { OpenClawVersionResult } from './openclaw-version';
import type { RuntimeInvariantIssue } from './runtime-invariants';

export interface DiagnosticsDeps {
  readConfig: () => Record<string, unknown> | null;
  detectEngineVersion: () => OpenClawVersionResult;
  gatewayStatus: () => { connected: boolean; endpoint?: string };
  browserHealth: () => { state: string };
  /** 运行时不变量。CI 照不到「某台机器上的状态坏了」，这一层补的就是那个。 */
  checkInvariants: () => RuntimeInvariantIssue[];
}

export interface DiagnosticsReport {
  generatedAt: string;
  app: { version: string | null };
  engine: { version: string | null; reason?: string; usesEntriesSchema: boolean | null };
  roster: { shape: string | null; count: number | null; entries?: Array<{ id: string; workspace: string | null }>; configReadFailed: boolean; detail?: string };
  gateway: { available: boolean; connected: boolean | null; endpoint?: string; detail?: string };
  browser: { available: boolean; state: string | null; detail?: string };
  runtime: { node: string; platform: string; arch: string };
  invariants: RuntimeInvariantIssue[];
  logs: LogEntry[];
}

/** 每一块都单独兜住：一块抛错只让那一块降级，不牵连其余。 */
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; detail: string } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    // 只留错误类别与错误码。message 原文可能嵌着输入（V8 的 JSON 报错就会）。
    return { ok: false, detail: sanitizeErrorDetail(error) };
  }
}

/** 日志默认只带最近这么多条：够看清一次失败的前因后果，又不至于让响应体过大。 */
export const DIAGNOSTICS_LOG_LIMIT = 120;

export function buildDiagnosticsReport(deps: DiagnosticsDeps, logLimit = DIAGNOSTICS_LOG_LIMIT): DiagnosticsReport {
  const appInfo = attempt(() => getCurrentAppVersionInfo());
  const engine = attempt(() => deps.detectEngineVersion());
  const config = attempt(() => deps.readConfig());
  const gateway = attempt(() => deps.gatewayStatus());
  const browser = attempt(() => deps.browserHealth());
  const invariants = attempt(() => deps.checkInvariants());

  const engineResult = engine.ok ? engine.value : null;

  // 名册形状要和引擎版本一起判——这是 agents-roster 门面的判据，
  // 不在这里重新实现一遍（重判一次正是 v1.5.1 那个坑的形状）。
  const roster = (() => {
    if (!config.ok) {
      return { shape: null, count: null, configReadFailed: true, detail: config.detail };
    }
    const raw = config.value;
    if (!raw) return { shape: null, count: 0, configReadFailed: false };
    const view = attempt(() => {
      const shape = resolveRosterShape(raw, engineResult ?? { known: false, reason: 'unknown' }).shape;
      const entries = listRosterEntries(raw, shape);
      return {
        shape,
        count: entries.length,
        // 带上每个 Agent 的 id 与工作区：排障时「引擎看不看得见这个 Agent」「它的
        // 工作区在哪」是最常问的两件事（v1.2.5 那次事故就是「新建的 Agent 引擎看不见」）。
        // 工作区是绝对路径、含用户名，靠返回前那道脱敏换成 ~。
        entries: entries.map((entry) => ({
          id: entry.id,
          workspace: typeof entry.workspace === 'string' ? entry.workspace : null,
        })),
      };
    });
    return view.ok
      ? { ...view.value, configReadFailed: false }
      : { shape: null, count: null, configReadFailed: true, detail: view.detail };
  })();

  const report: DiagnosticsReport = {
    generatedAt: new Date().toISOString(),
    app: { version: appInfo.ok ? (appInfo.value?.version ?? null) : null },
    engine: {
      version: engineResult?.known ? engineResult.raw : null,
      ...(engineResult && !engineResult.known ? { reason: engineResult.reason } : {}),
      ...(engine.ok ? {} : { reason: engine.detail }),
      usesEntriesSchema: engineResult?.known ? engineResult.month >= 8 || engineResult.year > 2026 : null,
    },
    roster,
    gateway: gateway.ok
      ? { available: true, connected: gateway.value.connected, endpoint: gateway.value.endpoint }
      : { available: false, connected: null, detail: gateway.detail },
    browser: browser.ok
      ? { available: true, state: browser.value.state }
      : { available: false, state: null, detail: browser.detail },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    // 检查器崩了要**说出来**，不能退化成空数组——空数组和「一切正常」在界面上
    // 无法区分，那正是这一层要防的那类故障（状态看起来对、实际不能用）。
    invariants: invariants.ok ? invariants.value : [{
      code: 'invariantsCheckerCrashed',
      severity: 'critical' as const,
      message: '运行时不变量检查器自身失败，本次报告里的「无告警」不可信',
      details: { detail: invariants.detail },
    }],
    logs: recentLogEntries(logLimit),
  };

  // 最后一道闸门：整份报告再过一次脱敏。
  // 上面每一块都已经小心过了，但「小心」不是机制——这一行才是。
  return redactLogValue(report) as DiagnosticsReport;
}
