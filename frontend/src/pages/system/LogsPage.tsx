// 日志查看（系统区）：网关文件日志（openclaw logs）与 ClawOPT 进程日志；级别过滤、关键字搜索、条数。
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { observabilityApi } from '../../api/control';
import { Button, Card, EmptyState, ErrorBanner, inputClass, LoadingRow, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type LogLine = { ts: string | null; level: string; source: string; subsystem: string | null; message: string };

const LEVEL_CLASS: Record<string, string> = {
  error: 'text-red-600',
  fatal: 'text-red-600',
  warn: 'text-amber-600',
  warning: 'text-amber-600',
  info: 'text-blue-600',
  debug: 'text-gray-400',
  trace: 'text-gray-400',
};

export default function LogsPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [source, setSource] = useState<'gateway' | 'clawopt'>('gateway');
  const [level, setLevel] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(300);
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);

  const load = useCallback(async () => {
    setLines(null);
    setError(null);
    try {
      const result = await readApi<{ lines: LogLine[] }>(observabilityApi.logs({ source, level, q: query, limit }));
      if (result.ok) setLines(result.data.lines);
      else {
        setLines([]);
        setError(errors.fromResult(result, 'control.logs.loadFailed'));
      }
    } catch (exception) {
      setLines([]);
      setError(errors.fromException(exception));
    }
    // 关键字不进依赖：按回车或刷新按钮才查——每敲一个字就去跑一次 CLI 太贵。
  }, [source, level, limit, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <PageIntro title={t('control.logs.title')} description={t('control.logs.description')} actions={<Button onClick={() => void load()}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <select value={source} onChange={(event) => setSource(event.target.value as 'gateway' | 'clawopt')} className={inputClass}>
          <option value="gateway">{t('control.logs.sourceGateway')}</option>
          <option value="clawopt">{t('control.logs.sourceClawopt')}</option>
        </select>
        <select value={level} onChange={(event) => setLevel(event.target.value)} className={inputClass}>
          {['all', 'error', 'warn', 'info', 'debug'].map((value) => <option key={value} value={value}>{t(`control.logs.level.${value}`)}</option>)}
        </select>
        <select value={limit} onChange={(event) => setLimit(Number(event.target.value))} className={inputClass}>
          {[100, 300, 1000].map((value) => <option key={value} value={value}>{t('control.logs.lines', { count: value })}</option>)}
        </select>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(); }}
          className={`${inputClass} col-span-2 md:col-span-1`}
          placeholder={t('control.logs.search')}
        />
      </div>
      {lines === null ? <LoadingRow /> : lines.length === 0 ? <EmptyState>{t('control.logs.empty')}</EmptyState> : (
        <Card className="overflow-hidden">
          <div className="overflow-auto max-h-[70vh] font-mono text-xs">
            {lines.map((line, index) => (
              <div key={index} className="flex gap-3 px-3 py-1.5 border-b border-gray-50 hover:bg-gray-50 min-w-[640px]">
                <span className="text-gray-400 shrink-0 w-44 truncate">{line.ts ?? ''}</span>
                <span className={`shrink-0 w-12 uppercase font-semibold ${LEVEL_CLASS[line.level] ?? 'text-gray-500'}`}>{line.level}</span>
                <span className="text-gray-500 shrink-0 w-24 truncate">{line.subsystem ?? ''}</span>
                <span className="text-gray-800 whitespace-pre-wrap break-all">{line.message}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
