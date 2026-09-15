// 用量分析（系统区）：总计、按天趋势、按模型、按 Agent。数据只来自引擎（ClawOPT 自己的库不记 token，避免重复计数）。
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { observabilityApi } from '../../api/control';
import { Button, Card, ErrorBanner, formatNumber, LoadingRow, NoPermissionState, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; totalCost: number; missingCostEntries: number };
type Row = { key: string; sessions: number; inputTokens: number; outputTokens: number; totalTokens: number };
type Summary = {
  days: number;
  cost: ({ available: true; totals: Totals; daily: Array<Totals & { date: string }> } | { available: false; errorCode: string });
  breakdown: ({ available: true; byModel: Row[]; byAgent: Row[]; sessionCount: number } | { available: false; errorCode: string });
  externalRuntimesTracked: boolean;
};

const PERIODS = [7, 30, 90];

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold text-gray-900 mt-1 break-all">{value}</div>
    </Card>
  );
}

function BreakdownTable({ title, rows, language }: { title: string; rows: Row[]; language: string }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((row) => row.totalTokens));
  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      {rows.length === 0 ? <div className="text-sm text-gray-400">{t('control.usage.noData')}</div> : (
        <div className="space-y-2">
          {rows.slice(0, 20).map((row) => (
            <div key={row.key} className="space-y-1">
              <div className="flex justify-between gap-2 text-xs">
                <span className="text-gray-700 truncate font-mono">{row.key}</span>
                <span className="text-gray-500 shrink-0">{formatNumber(row.totalTokens, language)} · {t('control.usage.sessions', { count: row.sessions })}</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className="h-full bg-blue-500" style={{ width: `${Math.max(2, (row.totalTokens / max) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function UsagePage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setSummary(null);
    setError(null);
    try {
      const result = await readApi<Summary>(observabilityApi.usage(days));
      setForbidden(result.status === 403);
      if (result.ok) setSummary(result.data);
      else if (result.status !== 403) setError(errors.fromResult(result, 'control.usage.loadFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    }
  }, [days, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const lang = i18n.language;
  const cost = summary?.cost.available ? summary.cost : null;
  const breakdown = summary?.breakdown.available ? summary.breakdown : null;
  const maxDaily = Math.max(1, ...(cost?.daily ?? []).map((day) => day.totalTokens));
  const cacheBase = cost ? cost.totals.input + cost.totals.cacheRead : 0;

  if (forbidden) return <NoPermissionState />;

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.usage.title')}
        description={t('control.usage.description')}
        actions={(
          <>
            {PERIODS.map((period) => (
              <Button key={period} variant={days === period ? 'primary' : 'secondary'} onClick={() => setDays(period)}>{t('control.usage.lastDays', { count: period })}</Button>
            ))}
            <Button onClick={() => void load()}><RefreshCw className="w-4 h-4" /></Button>
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Notice tone="blue">{t('control.usage.sourceHint')}</Notice>

      {!summary ? (!error && <LoadingRow />) : (
        <>
          {!summary.cost.available && <Notice>{t('control.usage.costUnavailable', { code: summary.cost.errorCode })}</Notice>}
          {cost && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <StatCard label={t('control.usage.totalTokens')} value={formatNumber(cost.totals.totalTokens, lang)} />
              <StatCard label={t('control.usage.avgPerDay')} value={formatNumber(Math.round(cost.totals.totalTokens / Math.max(1, summary.days)), lang)} />
              <StatCard label={t('control.usage.totalCost')} value={`$${cost.totals.totalCost.toFixed(4)}`} />
              <StatCard label={t('control.usage.cacheHitRate')} value={cacheBase > 0 ? `${Math.round((cost.totals.cacheRead / cacheBase) * 100)}%` : '—'} />
            </div>
          )}
          {cost && cost.totals.missingCostEntries > 0 && <Notice>{t('control.usage.missingCost', { count: cost.totals.missingCostEntries })}</Notice>}
          {cost && (
            <Card className="p-4 space-y-3">
              <div className="text-sm font-semibold text-gray-900">{t('control.usage.dailyTrend')}</div>
              <div className="overflow-x-auto">
                <div className="flex items-end gap-1 h-40 min-w-[480px]">
                  {cost.daily.map((day) => (
                    <div key={day.date} className="flex-1 flex flex-col items-center justify-end h-full group" title={`${day.date} · ${formatNumber(day.totalTokens, lang)}`}>
                      <div className="w-full rounded-t bg-blue-500/80 group-hover:bg-blue-600" style={{ height: `${(day.totalTokens / maxDaily) * 100}%`, minHeight: day.totalTokens > 0 ? 2 : 0 }} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[10px] text-gray-400 min-w-[480px] mt-1">
                  <span>{cost.daily[0]?.date}</span>
                  <span>{cost.daily[cost.daily.length - 1]?.date}</span>
                </div>
              </div>
            </Card>
          )}
          {!summary.breakdown.available && <Notice>{t('control.usage.breakdownUnavailable', { code: summary.breakdown.errorCode })}</Notice>}
          {breakdown && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <BreakdownTable title={t('control.usage.byModel')} rows={breakdown.byModel} language={lang} />
              <BreakdownTable title={t('control.usage.byAgent')} rows={breakdown.byAgent} language={lang} />
            </div>
          )}
          {!summary.externalRuntimesTracked && <p className="text-xs text-gray-400">{t('control.usage.externalNotTracked')}</p>}
        </>
      )}
    </div>
  );
}
