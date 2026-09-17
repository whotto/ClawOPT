// 性能监控（系统区，super_admin）：系统 CPU / 内存 / 负载、本进程、协调器活跃运行与排队、ClawOPT 的子进程；自动刷新。
// 页面隐藏时暂停刷新，回到前台立即取一次；接口回 403 显示没有权限。
import { Pause, Play, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { performanceApi } from '../../api/performance';
import { Badge, Button, Card, EmptyState, ErrorBanner, inputClass, LoadingRow, NoPermissionState, PageIntro, formatTime, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';
import { DEFAULT_REFRESH_MS, REFRESH_INTERVALS_MS, formatBytes, formatDuration, normalizeRefreshInterval, usageTone, type UsageTone } from './performanceFormat';

type Snapshot = {
  takenAt: number;
  system: { platform: string; arch: string; uptimeSec: number; cpuCount: number; cpuPercent: number | null; loadAverage: number[]; memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number; source: string } };
  process: { pid: number; uptimeSec: number; node: string; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number; cpuPercent: number | null };
  runs: { active: Array<{ sessionKey: string; runtime: string; agentId: string; phase: string; aborting: boolean; startedAt: number; queued: number }>; byRuntime: Record<string, number>; byAgent: Record<string, number>; queuedTotal: number; workflowActiveRuns: number | null; error: string | null };
  children: { rows: Array<{ pid: number; ppid: number; cpuPercent: number; rssKb: number; elapsed: string; command: string; runtime: string | null; depth: number }>; totalRssKb: number; error: string | null };
  errors: string[];
};

const INTERVAL_STORAGE_KEY = 'clawopt.performance.refreshMs';

const BAR_CLASS: Record<UsageTone, string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  gray: 'bg-gray-300',
};

function readStoredInterval(): number {
  try {
    return normalizeRefreshInterval(window.localStorage.getItem(INTERVAL_STORAGE_KEY));
  } catch {
    return DEFAULT_REFRESH_MS;
  }
}

function UsageBar({ percent }: { percent: number | null }) {
  const tone = usageTone(percent);
  return (
    <div className="h-2 rounded-full bg-gray-100 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
      <div className={`h-full ${BAR_CLASS[tone]} transition-all`} style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
    </div>
  );
}

function Metric({ label, value, sub, percent }: { label: string; value: string; sub?: string; percent?: number | null }) {
  return (
    <Card className="p-4 space-y-2 min-w-0">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 font-mono truncate">{value}</div>
      {percent !== undefined && <UsageBar percent={percent} />}
      {sub && <div className="text-xs text-gray-500 truncate">{sub}</div>}
    </Card>
  );
}

function CountList({ title, counts, empty }: { title: string; counts: Record<string, number>; empty: string }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return (
    <Card className="p-4 space-y-2 min-w-0">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      {entries.length === 0 ? <div className="text-sm text-gray-400">{empty}</div> : (
        <ul className="space-y-1.5">
          {entries.map(([key, count]) => (
            <li key={key} className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-gray-700 truncate">{key}</span>
              <Badge tone="blue">{count}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default function PerformancePage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [intervalMs, setIntervalMs] = useState(readStoredInterval);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const result = await readApi<{ snapshot: Snapshot }>(performanceApi.snapshot());
      if (result.status === 403) {
        setForbidden(true);
        return;
      }
      if (result.ok) {
        setSnapshot(result.data.snapshot);
        setError(null);
      } else setError(errors.fromResult(result, 'performance.loadFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [errors]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paused || forbidden) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [paused, forbidden, intervalMs, load]);

  const changeInterval = (value: string) => {
    const next = normalizeRefreshInterval(value);
    setIntervalMs(next);
    try {
      window.localStorage.setItem(INTERVAL_STORAGE_KEY, String(next));
    } catch {
      // 本机偏好写不进不影响刷新。
    }
  };

  if (forbidden) return <NoPermissionState />;

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('performance.title')}
        description={t('performance.description')}
        actions={(
          <>
            <select value={intervalMs} onChange={(event) => changeInterval(event.target.value)} className={`${inputClass} w-36`} aria-label={t('performance.interval')}>
              {REFRESH_INTERVALS_MS.map((value) => <option key={value} value={value}>{t('performance.every', { seconds: value / 1000 })}</option>)}
            </select>
            <Button onClick={() => setPaused((value) => !value)}>
              {paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              {paused ? t('performance.resume') : t('performance.pause')}
            </Button>
            <Button onClick={() => void load()} busy={loading}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {!snapshot ? <LoadingRow /> : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <Badge tone={paused ? 'gray' : 'green'}>{paused ? t('performance.paused') : t('performance.live')}</Badge>
            <span>{t('performance.takenAt', { time: formatTime(snapshot.takenAt, i18n.language) })}</span>
            <span className="font-mono">{snapshot.system.platform}/{snapshot.system.arch}</span>
            <span>{t('performance.hostUptime', { value: formatDuration(snapshot.system.uptimeSec) })}</span>
          </div>
          {snapshot.errors.length > 0 && <div className="text-xs text-amber-700 font-mono">{t('performance.partial')}: {snapshot.errors.join(', ')}</div>}

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Metric label={t('performance.cpu')} value={snapshot.system.cpuPercent === null ? '—' : `${snapshot.system.cpuPercent}%`} percent={snapshot.system.cpuPercent} sub={t('performance.cores', { count: snapshot.system.cpuCount })} />
            <Metric
              label={t('performance.memory')}
              value={`${snapshot.system.memory.usedPercent}%`}
              percent={snapshot.system.memory.usedPercent}
              sub={t('performance.memorySub', { used: formatBytes(snapshot.system.memory.usedBytes), total: formatBytes(snapshot.system.memory.totalBytes), available: formatBytes(snapshot.system.memory.availableBytes) })}
            />
            <Metric label={t('performance.load')} value={snapshot.system.loadAverage.map((value) => value.toFixed(2)).join(' / ')} sub={t('performance.loadSub')} />
            <Metric
              label={t('performance.process')}
              value={formatBytes(snapshot.process.rssBytes)}
              sub={t('performance.processSub', { pid: snapshot.process.pid, cpu: snapshot.process.cpuPercent === null ? '—' : `${snapshot.process.cpuPercent}%`, heap: formatBytes(snapshot.process.heapUsedBytes), uptime: formatDuration(snapshot.process.uptimeSec) })}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Metric label={t('performance.activeRuns')} value={String(snapshot.runs.active.length)} sub={t('performance.queuedTotal', { count: snapshot.runs.queuedTotal })} />
            <CountList title={t('performance.byRuntime')} counts={snapshot.runs.byRuntime} empty={t('performance.noRuns')} />
            <CountList title={t('performance.byAgent')} counts={snapshot.runs.byAgent} empty={t('performance.noRuns')} />
          </div>
          {snapshot.runs.error && <div className="text-xs text-amber-700">{t('performance.blockFailed', { code: snapshot.runs.error })}</div>}

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-gray-900">{t('performance.runsTitle')}</div>
              <span className="text-xs text-gray-500">{snapshot.runs.workflowActiveRuns === null ? '' : t('performance.workflowRuns', { count: snapshot.runs.workflowActiveRuns })}</span>
            </div>
            {snapshot.runs.active.length === 0 ? <div className="px-4 py-6 text-sm text-gray-400 text-center">{t('performance.noRuns')}</div> : (
              <div className="overflow-x-auto">
                <table className="min-w-[640px] w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="text-left font-medium px-4 py-2">{t('performance.colSession')}</th>
                      <th className="text-left font-medium px-4 py-2">{t('performance.colRuntime')}</th>
                      <th className="text-left font-medium px-4 py-2">{t('performance.colAgent')}</th>
                      <th className="text-left font-medium px-4 py-2">{t('performance.colPhase')}</th>
                      <th className="text-right font-medium px-4 py-2">{t('performance.colQueued')}</th>
                      <th className="text-right font-medium px-4 py-2">{t('performance.colElapsed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.runs.active.map((run) => (
                      <tr key={run.sessionKey} className="border-t border-gray-100">
                        <td className="px-4 py-2 font-mono text-xs text-gray-700 max-w-[16rem] truncate">{run.sessionKey}</td>
                        <td className="px-4 py-2 font-mono text-xs">{run.runtime}</td>
                        <td className="px-4 py-2 font-mono text-xs">{run.agentId}</td>
                        <td className="px-4 py-2"><Badge tone={run.aborting ? 'amber' : run.phase === 'running' ? 'green' : 'gray'}>{run.aborting ? t('performance.phase.aborting') : t(`performance.phase.${run.phase}`)}</Badge></td>
                        <td className="px-4 py-2 text-right font-mono">{run.queued}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{formatDuration(Math.max(0, (snapshot.takenAt - run.startedAt) / 1000))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-gray-900">{t('performance.childrenTitle')}</div>
              <span className="text-xs text-gray-500">{t('performance.childrenSub', { count: snapshot.children.rows.length, rss: formatBytes(snapshot.children.totalRssKb * 1024) })}</span>
            </div>
            {snapshot.children.error ? (
              <div className="px-4 py-6 text-sm text-amber-700 text-center">{t('performance.blockFailed', { code: snapshot.children.error })}</div>
            ) : snapshot.children.rows.length === 0 ? (
              <EmptyState>{t('performance.noChildren')}</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-[560px] w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="text-left font-medium px-4 py-2">PID</th>
                      <th className="text-left font-medium px-4 py-2">{t('performance.colCommand')}</th>
                      <th className="text-left font-medium px-4 py-2">{t('performance.colRuntime')}</th>
                      <th className="text-right font-medium px-4 py-2">CPU</th>
                      <th className="text-right font-medium px-4 py-2">RSS</th>
                      <th className="text-right font-medium px-4 py-2">{t('performance.colElapsed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.children.rows.map((row) => (
                      <tr key={row.pid} className="border-t border-gray-100">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">{row.pid}</td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-800" style={{ paddingLeft: `${1 + (row.depth - 1) * 1.25}rem` }}>{row.command}</td>
                        <td className="px-4 py-2">{row.runtime ? <Badge tone="blue">{row.runtime}</Badge> : <span className="text-gray-400">—</span>}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{row.cpuPercent.toFixed(1)}%</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{formatBytes(row.rssKb * 1024)}</td>
                        <td className="px-4 py-2 text-right font-mono text-xs">{row.elapsed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
