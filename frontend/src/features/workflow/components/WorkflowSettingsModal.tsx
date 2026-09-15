// 工作流运行设置：每次运行同时执行的节点数上限。主机低内存时强制为 1，并说明原因。
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkflowSettings, saveWorkflowSettings } from '../../../api/automation';
import { describeError, requestJson } from '../lib/request';
import { ErrorBanner, Field, InfoBanner, Modal, inputClass, primaryButton, secondaryButton } from './ui';

export type ConcurrencyInfo = { configured: number; effective: number; lowMemory: boolean; totalBytes: number; availableBytes: number | null };

export function useConcurrencyInfo() {
  const [info, setInfo] = useState<{ concurrency: ConcurrencyInfo; maxConcurrencyLimit: number } | null>(null);
  const reload = async () => {
    const result = await requestJson<{ concurrency: ConcurrencyInfo; maxConcurrencyLimit: number }>(getWorkflowSettings());
    if (result.ok) setInfo(result.data);
  };
  useEffect(() => {
    void reload();
  }, []);
  return { info, reload };
}

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

export default function WorkflowSettingsModal({ info, onSaved, onClose }: {
  info: { concurrency: ConcurrencyInfo; maxConcurrencyLimit: number } | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(String(info?.concurrency.configured ?? 2));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const result = await requestJson(saveWorkflowSettings(Number(value)));
    setSaving(false);
    if (!result.ok) return setProblem(describeError(t, result.error));
    onSaved();
    onClose();
  };

  return (
    <Modal
      title={t('automation.settings.title')}
      onClose={onClose}
      width="max-w-md"
      footer={(
        <>
          <button className={secondaryButton} onClick={onClose}>{t('common.cancel')}</button>
          <button className={primaryButton} disabled={saving} onClick={() => void save()}>{t('common.save')}</button>
        </>
      )}
    >
      {problem && <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />}
      <Field label={t('automation.settings.concurrency')} hint={t('automation.settings.concurrencyHint', { max: info?.maxConcurrencyLimit ?? 8 })}>
        <input className={inputClass} type="number" min={1} max={info?.maxConcurrencyLimit ?? 8} value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      {info?.concurrency.lowMemory && (
        <InfoBanner>
          {t('automation.settings.lowMemory', {
            total: gib(info.concurrency.totalBytes),
            available: info.concurrency.availableBytes === null ? '—' : gib(info.concurrency.availableBytes),
          })}
        </InfoBanner>
      )}
    </Modal>
  );
}
