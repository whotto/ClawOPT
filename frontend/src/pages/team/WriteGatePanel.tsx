// 写入审批面板：开关 + 待审记录 + 审阅（diff、当前 / 提议）+ 批准 / 拒绝。帮助文本如实写明机制与局限。
import { Check, Eye, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { writeGateApi } from '../../api/control';
import { Badge, Button, ErrorBanner, formatTime, LoadingRow, Modal, Notice, Toggle, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type Record_ = { id: string; agentId: string; relPath: string; action: 'create' | 'update' | 'delete'; origin: string; baseHash: string | null; proposedHash: string | null; createdAt: number; updatedAt: number };
type Review = { record: Record_; base: string | null; proposed: string | null; current: string | null; diff: string; notes: string[] };

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-3 overflow-auto max-h-[45vh]">
      {diff.split('\n').map((line, index) => (
        <div key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-green-700 bg-green-50' : line.startsWith('-') && !line.startsWith('---') ? 'text-red-600 bg-red-50' : line.startsWith('@@') ? 'text-blue-600' : 'text-gray-600'}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

export default function WriteGatePanel({ agentId, canEdit, onCountChange }: { agentId: string; canEdit: boolean; onCountChange?: (count: number) => void }) {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [records, setRecords] = useState<Record_[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [settings, pending] = await Promise.all([
        readApi<{ settings: Array<{ agentId: string; enabled: boolean }> }>(writeGateApi.settings()),
        readApi<{ records: Record_[] }>(writeGateApi.pending()),
      ]);
      if (settings.ok) setEnabled(settings.data.settings.some((entry) => entry.agentId === agentId && entry.enabled));
      if (pending.ok) {
        const mine = pending.data.records.filter((record) => record.agentId === agentId);
        setRecords(mine);
        onCountChange?.(mine.length);
      } else setError(errors.fromResult(pending));
    } catch (exception) {
      setError(errors.fromException(exception));
    }
  }, [agentId, errors, onCountChange]);

  useEffect(() => {
    setError(null);
    void load();
  }, [load]);

  const run = async (key: string, request: () => Promise<Response>, onOk?: (data: Record<string, unknown>) => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi<Record<string, unknown>>(request());
      if (result.ok) onOk?.(result.data);
      else setError(errors.fromResult(result));
      await load();
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const openReview = async (record: Record_) => {
    const result = await readApi<{ review: Review }>(writeGateApi.review(record.id)).catch(() => null);
    if (result?.ok) setReview(result.data.review);
    else if (result) setError(errors.fromResult(result));
  };

  return (
    <div className="space-y-4">
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div className="flex items-start justify-between gap-4 rounded-2xl border border-gray-200 p-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900">{t('control.writeGate.toggle')}</div>
          <p className="text-xs text-gray-500 mt-1">{t('control.writeGate.toggleHint')}</p>
        </div>
        {enabled !== null && <Toggle label={t('control.writeGate.toggle')} checked={enabled} disabled={!canEdit || busy === 'toggle'} onChange={(next) => void run('toggle', () => writeGateApi.setEnabled(agentId, next))} />}
      </div>
      <Notice tone="blue">{t('control.writeGate.limits')}</Notice>

      {records === null ? <LoadingRow /> : records.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-6">{t('control.writeGate.empty')}</div>
      ) : (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-2xl">
          {records.map((record) => (
            <div key={record.id} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-gray-900 break-all">{record.relPath}</span>
                  <Badge tone={record.action === 'delete' ? 'red' : record.action === 'create' ? 'green' : 'blue'}>{t(`control.writeGate.action.${record.action}`)}</Badge>
                </div>
                <div className="text-xs text-gray-400">{t(`control.writeGate.origin.${record.origin}`, { defaultValue: record.origin })} · {formatTime(record.updatedAt, i18n.language)}</div>
              </div>
              <Button size="sm" onClick={() => void openReview(record)}><Eye className="w-3.5 h-3.5" />{t('control.writeGate.review')}</Button>
            </div>
          ))}
        </div>
      )}

      {review && (
        <Modal
          title={t('control.writeGate.reviewTitle', { path: review.record.relPath })}
          onClose={() => setReview(null)}
          width="max-w-4xl"
          footer={canEdit ? (
            <>
              <Button variant="danger" busy={busy === 'reject'} onClick={() => void run('reject', () => writeGateApi.reject(review.record.id), () => setReview(null))}><X className="w-4 h-4" />{t('control.writeGate.reject')}</Button>
              <Button variant="primary" busy={busy === 'approve'} onClick={() => void run('approve', () => writeGateApi.approve(review.record.id, { baseHash: review.record.baseHash, proposedHash: review.record.proposedHash }), () => setReview(null))}><Check className="w-4 h-4" />{t('control.writeGate.approve')}</Button>
            </>
          ) : undefined}
        >
          {review.notes.map((note) => <Notice key={note} tone={note === 'noOp' ? 'blue' : 'amber'}>{t(`control.writeGate.note.${note}`)}</Notice>)}
          {review.diff ? <DiffView diff={review.diff} /> : <div className="text-sm text-gray-400">{t('control.writeGate.noDiff')}</div>}
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-600">{t('control.writeGate.showFull')}</summary>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
              <div>
                <div className="text-xs text-gray-500 mb-1">{t('control.writeGate.approvedVersion')}</div>
                <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-3 overflow-auto max-h-[35vh] whitespace-pre-wrap break-all">{review.base ?? t('control.writeGate.absent')}</pre>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">{t('control.writeGate.proposedVersion')}</div>
                <pre className="text-xs font-mono bg-gray-50 border border-gray-200 rounded-xl p-3 overflow-auto max-h-[35vh] whitespace-pre-wrap break-all">{review.proposed ?? t('control.writeGate.absent')}</pre>
              </div>
            </div>
          </details>
        </Modal>
      )}
    </div>
  );
}
