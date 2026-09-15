// 运行前的预算弹窗：不限 / 30 / 60 / 90 分钟 / 自定义；首跑还可给开始节点一段输入。重跑复用同一个弹窗。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BUDGET_PRESETS, budgetToTimeoutMs } from '../lib/schedule-frequency';
import { ErrorBanner, Field, InfoBanner, Modal, inputClass, primaryButton, secondaryButton } from './ui';

export default function RunBudgetModal({ title, showInput, staticBound, concurrency, busy, onSubmit, onClose }: {
  title: string;
  showInput: boolean;
  staticBound: number | null;
  concurrency: { effective: number; lowMemory: boolean } | null;
  busy: boolean;
  onSubmit: (input: { timeoutMs: number | null; input: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<string>('null');
  const [custom, setCustom] = useState('15');
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = () => {
    try {
      const minutes = preset === 'custom' ? Number(custom) : preset === 'null' ? null : Number(preset);
      onSubmit({ timeoutMs: budgetToTimeoutMs(minutes), input });
    } catch {
      setProblem(t('automation.budget.customInvalid'));
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      width="max-w-md"
      footer={(
        <>
          <button className={secondaryButton} onClick={onClose}>{t('common.cancel')}</button>
          <button className={primaryButton} disabled={busy} onClick={submit}>{t('automation.budget.start')}</button>
        </>
      )}
    >
      {problem && <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />}
      <Field label={t('automation.budget.label')} hint={t('automation.budget.hint')}>
        <div className="flex flex-wrap gap-2">
          {[...BUDGET_PRESETS.map(String), 'custom'].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setPreset(value)}
              className={`px-3 py-1.5 text-sm rounded-xl border ${preset === value ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300' : 'text-gray-600 bg-white border-gray-200 hover:bg-gray-50'}`}
            >
              {value === 'null' ? t('automation.budget.unlimited') : value === 'custom' ? t('automation.budget.custom') : t('automation.budget.minutes', { count: Number(value) })}
            </button>
          ))}
        </div>
      </Field>
      {preset === 'custom' && (
        <Field label={t('automation.budget.customMinutes')}>
          <input className={inputClass} type="number" min={0.1} max={1440} step={0.1} value={custom} onChange={(event) => setCustom(event.target.value)} />
        </Field>
      )}
      {showInput && (
        <Field label={t('automation.budget.input')} hint={t('automation.budget.inputHint')}>
          <textarea className={`${inputClass} min-h-[80px]`} value={input} onChange={(event) => setInput(event.target.value)} />
        </Field>
      )}
      {(staticBound !== null || concurrency) && (
        <InfoBanner>
          {staticBound !== null && <div>{t('automation.budget.staticBound', { bound: staticBound })}</div>}
          {concurrency && <div>{t(concurrency.lowMemory ? 'automation.budget.concurrencyLowMemory' : 'automation.budget.concurrency', { count: concurrency.effective })}</div>}
        </InfoBanner>
      )}
    </Modal>
  );
}
