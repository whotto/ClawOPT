// 「记住」：人在界面上显式写一条记忆（不经意图闸门，服务端仍按种类生成规范键、走 supersede 与审计）。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { memoryApi } from '../../api/memory';
import { Button, ErrorBanner, inputClass, labelClass, Modal, textareaClass, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useErrorDisplay } from '../../pages/control/useControlApi';

/** 界面里给人选的种类（多值种类要 itemKey）。结构化种类（称呼约定、住址）走 Agent 工具或后续编辑器。 */
export const REMEMBER_KINDS: Array<{ kind: string; itemized: boolean }> = [
  { kind: 'general_preference', itemized: true },
  { kind: 'communication_preference', itemized: true },
  { kind: 'workflow_preference', itemized: true },
  { kind: 'tool_preference', itemized: true },
  { kind: 'hard_constraint', itemized: true },
  { kind: 'project_context', itemized: true },
  { kind: 'durable_decision', itemized: true },
  { kind: 'custom_fact', itemized: true },
  { kind: 'correction', itemized: true },
  { kind: 'profile_name', itemized: false },
  { kind: 'occupation', itemized: false },
  { kind: 'timezone', itemized: false },
  { kind: 'language', itemized: false },
];

export function RememberModal({ profileIds, defaultProfileId, onClose, onSaved }: {
  profileIds: string[];
  defaultProfileId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [profileId, setProfileId] = useState(defaultProfileId ?? profileIds[0] ?? '');
  const [kind, setKind] = useState(REMEMBER_KINDS[0].kind);
  const [itemKey, setItemKey] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const itemized = REMEMBER_KINDS.find((entry) => entry.kind === kind)?.itemized ?? true;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await readApi(memoryApi.remember({ profileId: profileId.trim(), kind, itemKey: itemized ? itemKey : undefined, title, content }));
      if (result.ok) onSaved();
      else setError(errors.fromResult(result, 'memoryService.page.saveFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('memoryService.page.rememberTitle')}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={!profileId.trim() || !title.trim() || !content.trim() || (itemized && !itemKey.trim())} onClick={() => void submit()}>
            {t('memoryService.page.remember')}
          </Button>
        </>
      )}
    >
      <p className="text-sm text-gray-500">{t('memoryService.page.rememberHint')}</p>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <div>
        <label className={labelClass}>{t('memoryService.page.fieldProfile')}</label>
        <input className={inputClass} list="memory-profile-options" value={profileId} onChange={(event) => setProfileId(event.target.value)} />
        <datalist id="memory-profile-options">
          {profileIds.map((id) => <option key={id} value={id} />)}
        </datalist>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>{t('memoryService.page.fieldKind')}</label>
          <select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value)}>
            {REMEMBER_KINDS.map((entry) => <option key={entry.kind} value={entry.kind}>{t(`memoryService.page.kind.${entry.kind}`)}</option>)}
          </select>
        </div>
        {itemized && (
          <div>
            <label className={labelClass}>{t('memoryService.page.fieldItemKey')}</label>
            <input className={inputClass} value={itemKey} onChange={(event) => setItemKey(event.target.value)} placeholder={t('memoryService.page.itemKeyPlaceholder')} maxLength={64} />
          </div>
        )}
      </div>
      <div>
        <label className={labelClass}>{t('memoryService.page.fieldTitle')}</label>
        <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
      </div>
      <div>
        <label className={labelClass}>{t('memoryService.page.fieldContent')}</label>
        <textarea className={`${textareaClass} min-h-[6rem]`} value={content} onChange={(event) => setContent(event.target.value)} maxLength={4000} />
      </div>
    </Modal>
  );
}
