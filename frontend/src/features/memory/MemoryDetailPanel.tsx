// 选中卡片的详情：键、分类、实体、作用域、版本、置信度、重要度、更新时间、来源；编辑（带版本号，冲突时载入最新）与软删除。
import { Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { memoryApi } from '../../api/memory';
import { Badge, Button, Card, ConfirmDialog, ErrorBanner, formatTime, inputClass, labelClass, Notice, textareaClass, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../../pages/control/useControlApi';
import { scopeLabel, valueText, type MemoryCardView } from './memoryModel';

type MutationBody = { result?: { card: MemoryCardView | null }; current?: MemoryCardView };

export function MemoryDetailPanel({ card, onClose, onChanged }: {
  card: MemoryCardView;
  onClose: () => void;
  /** 改动成功或发现别处已改：交回最新的卡片（软删后仍是那张卡，状态 deleted），页面据此重新载入。 */
  onChanged: (next: MemoryCardView | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [content, setContent] = useState(card.content);
  const [tags, setTags] = useState(card.tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    setEditing(false);
    setTitle(card.title);
    setContent(card.content);
    setTags(card.tags.join(', '));
    setError(null);
  }, [card.id, card.revision, card.title, card.content, card.tags]);

  const handleConflict = (status: number, body: MutationBody) => {
    if (status === 412 && body.current) {
      setConflict(true);
      onChanged(body.current);
      return true;
    }
    return false;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setConflict(false);
    try {
      const result = await readApi<MutationBody>(memoryApi.update(card.id, {
        expectedRevision: card.revision,
        title,
        content,
        tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      }));
      if (result.ok) {
        setEditing(false);
        onChanged(result.data.result?.card ?? null);
      } else if (!handleConflict(result.status, result.data)) {
        setError(errors.fromResult(result, 'memoryService.page.saveFailed'));
      }
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await readApi<MutationBody>(memoryApi.remove(card.id, card.revision));
      setConfirmDelete(false);
      if (result.ok) onChanged(result.data.result?.card ?? null);
      else if (!handleConflict(result.status, result.data)) setError(errors.fromResult(result, 'memoryService.page.deleteFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, mono = false) => (
    <div className="min-w-0">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`text-sm text-gray-800 break-all ${mono ? 'font-mono text-[12px]' : ''}`}>{value || '—'}</dd>
    </div>
  );

  return (
    <Card className="p-4 space-y-4" >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-gray-900 break-words">{card.title}</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge tone={card.status === 'active' ? 'green' : card.status === 'deleted' ? 'red' : 'gray'}>{t(`memoryService.page.status.${card.status}`)}</Badge>
            <Badge tone="gray">{t(`memoryService.page.scope.${card.scope.type}`)}</Badge>
            <Badge tone="gray">r{card.revision}</Badge>
          </div>
        </div>
        <button type="button" onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg" title={t('common.close')}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {conflict && <Notice>{t('memoryService.page.conflictReloaded')}</Notice>}
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {editing ? (
        <div className="space-y-3">
          <div>
            <label className={labelClass}>{t('memoryService.page.fieldTitle')}</label>
            <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
          </div>
          <div>
            <label className={labelClass}>{t('memoryService.page.fieldContent')}</label>
            <textarea className={`${textareaClass} min-h-[6rem]`} value={content} onChange={(event) => setContent(event.target.value)} maxLength={4000} />
          </div>
          <div>
            <label className={labelClass}>{t('memoryService.page.fieldTags')}</label>
            <input className={inputClass} value={tags} onChange={(event) => setTags(event.target.value)} />
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setEditing(false)} disabled={busy}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void save()} busy={busy} disabled={!title.trim() || !content.trim()}>{t('memoryService.page.save')}</Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{card.content}</p>
      )}
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {field(t('memoryService.page.fieldKey'), card.key, true)}
        {field(t('memoryService.page.fieldCategory'), card.categoryPath, true)}
        {field(t('memoryService.page.fieldValue'), valueText(card.value))}
        {field(t('memoryService.page.fieldScope'), scopeLabel(card.scope), true)}
        {field(t('memoryService.page.fieldEntities'), card.entities.join(', '))}
        {field(t('memoryService.page.fieldTags'), card.tags.join(', '))}
        {field(t('memoryService.page.fieldConfidence'), card.confidence.toFixed(2))}
        {field(t('memoryService.page.fieldImportance'), card.importance.toFixed(2))}
        {field(t('memoryService.page.fieldUpdated'), formatTime(Date.parse(card.updatedAt), i18n.language))}
        {field(t('memoryService.page.fieldSources'), card.sourceMessageIds.join(', '), true)}
      </dl>
      {card.status === 'active' && !editing && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" onClick={() => setEditing(true)}><Pencil className="w-3.5 h-3.5" />{t('memoryService.page.edit')}</Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 className="w-3.5 h-3.5" />{t('memoryService.page.delete')}</Button>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('memoryService.page.deleteTitle')}
          message={t('memoryService.page.deleteMessage', { title: card.title })}
          confirmLabel={t('memoryService.page.delete')}
          busy={busy}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Card>
  );
}
