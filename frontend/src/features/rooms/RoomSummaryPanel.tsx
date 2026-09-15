// 滚动摘要（P3 任务 4）：状态胶囊 + 侧板（锚点、摘要正文、手动编辑按版本号 CAS、立即摘要）。
// 摘要没配模型时只是提示——发消息从不因为摘要而受阻。
import { BookText, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RoomApiError, roomApi, type SummaryState } from './api';

export function SummaryChip({ summary, onOpen }: { summary: SummaryState | null; onOpen: () => void }) {
  const { t } = useTranslation();
  if (!summary) return null;
  const tone = !summary.configured
    ? 'text-gray-400 border-gray-200'
    : summary.status === 'failed' ? 'text-red-600 border-red-200 bg-red-50'
      : summary.status === 'summarizing' ? 'text-blue-600 border-blue-200 bg-blue-50' : 'text-gray-600 border-gray-200';
  return (
    <button type="button" onClick={onOpen} className={`inline-flex items-center gap-1.5 rounded-lg border px-2 h-8 text-xs ${tone}`} data-testid="room-summary-chip">
      {summary.status === 'summarizing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookText className="w-3.5 h-3.5" />}
      <span className="hidden sm:inline">{t(summary.configured ? `rooms.summary.status.${summary.status}` : 'rooms.summary.notConfigured')}</span>
    </button>
  );
}

export function RoomSummaryPanel({ groupId, summary, canManage, onClose, onChanged }: {
  groupId: string;
  summary: SummaryState | null;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<{ id: number; sender_name: string; content: string } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    roomApi.summary(groupId).then((result) => setAnchor(result.anchor)).catch(() => setAnchor(null));
  }, [groupId, summary?.version]);

  const save = async () => {
    if (!summary || draft === null) return;
    setBusy(true);
    setError('');
    try {
      await roomApi.editSummary(groupId, draft, summary.version);
      setDraft(null);
      onChanged();
    } catch (err) {
      setError(err instanceof RoomApiError ? t(err.code, { defaultValue: err.message }) : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setError('');
    try {
      await roomApi.runSummary(groupId);
      onChanged();
    } catch (err) {
      setError(err instanceof RoomApiError ? t(err.code, { defaultValue: err.message }) : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose} data-testid="room-summary-panel">
      <aside className="h-full w-full sm:w-[28rem] bg-white shadow-xl flex flex-col" onClick={(event) => event.stopPropagation()}>
        <header className="h-14 px-4 flex items-center justify-between border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900">{t('rooms.summary.title')}</h2>
          <button type="button" onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700" aria-label={t('common.close')}><X className="w-5 h-5" /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          {!summary?.configured && <p className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-gray-600">{t('rooms.summary.notConfiguredHint')}</p>}
          {summary && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-500">
              <dt>{t('rooms.summary.model')}</dt><dd className="text-gray-800 truncate">{summary.model || '—'}</dd>
              <dt>{t('rooms.summary.cadence')}</dt><dd className="text-gray-800">{t('rooms.summary.everyTurns', { count: summary.everyTurns })}</dd>
              <dt>{t('rooms.summary.statusLabel')}</dt><dd className="text-gray-800">{t(`rooms.summary.status.${summary.status}`)}</dd>
              <dt>{t('rooms.summary.pending')}</dt><dd className="text-gray-800">{summary.pendingTurns}</dd>
            </dl>
          )}
          {summary?.lastError && <p className="text-xs text-red-600 break-words">{summary.lastError}</p>}
          {anchor && (
            <div className="rounded-lg border border-gray-200 px-3 py-2">
              <p className="text-[11px] text-gray-400">{t('rooms.summary.anchor', { name: anchor.sender_name })}</p>
              <p className="text-xs text-gray-700 line-clamp-3 break-words">{anchor.content}</p>
            </div>
          )}
          {draft === null ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-gray-800 bg-gray-50 rounded-lg p-3 min-h-[8rem]">{summary?.summary || t('rooms.summary.empty')}</pre>
          ) : (
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} className="w-full min-h-[16rem] rounded-lg border border-gray-300 p-3 text-sm focus:outline-none focus:border-blue-500" />
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        {canManage && (
          <footer className="p-3 border-t border-gray-200 flex flex-wrap gap-2 justify-end">
            {draft === null ? (
              <>
                <button type="button" disabled={busy || !summary?.configured} onClick={runNow} className="px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50">{t('rooms.summary.runNow')}</button>
                <button type="button" disabled={busy || !summary} onClick={() => setDraft(summary?.summary ?? '')} className="px-3 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{t('common.edit')}</button>
              </>
            ) : (
              <>
                <button type="button" disabled={busy} onClick={() => setDraft(null)} className="px-3 py-2 text-sm rounded-lg border border-gray-200 hover:bg-gray-50">{t('common.cancel')}</button>
                <button type="button" disabled={busy} onClick={save} className="px-3 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">{t('common.save')}</button>
              </>
            )}
          </footer>
        )}
      </aside>
    </div>
  );
}
