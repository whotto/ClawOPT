// 导入导出：导出下载 `clawopt.workflow` 信封；导入两阶段（预览令牌 → 确认「名称 · N 个节点 · M 条边」）。
import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cancelWorkflowImport, confirmWorkflowImport, exportWorkflow, previewWorkflowImport } from '../../../api/automation';
import { describeError, requestJson } from '../lib/request';
import type { WorkflowDefinition } from '../lib/types';
import { ErrorBanner, InfoBanner, Modal, downloadText, inputClass, primaryButton, secondaryButton } from './ui';

type Preview = { token: string; summary: { name: string; nodes: number; edges: number } };

export default function ImportExportModal({ workflow, onImported, onClose }: {
  workflow: { id: string; name: string } | null;
  onImported: (workflow: WorkflowDefinition) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const doExport = async () => {
    if (!workflow) return;
    const result = await requestJson<{ envelope: unknown }>(exportWorkflow(workflow.id));
    if (!result.ok) return setProblem(describeError(t, result.error));
    downloadText(`${workflow.name.replace(/[^\w一-龥-]+/g, '-') || 'workflow'}.workflow.json`, JSON.stringify(result.data.envelope, null, 2));
  };

  const doPreview = async () => {
    setBusy(true);
    const result = await requestJson<Preview>(previewWorkflowImport(text));
    setBusy(false);
    if (!result.ok) return setProblem(describeError(t, result.error));
    setProblem(null);
    setPreview(result.data);
  };

  const doConfirm = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await requestJson<{ workflow: WorkflowDefinition }>(confirmWorkflowImport(preview.token));
    setBusy(false);
    setPreview(null);
    if (!result.ok) return setProblem(describeError(t, result.error));
    onImported(result.data.workflow);
    onClose();
  };

  const close = () => {
    if (preview) void cancelWorkflowImport(preview.token);
    onClose();
  };

  return (
    <Modal title={t('automation.io.title')} onClose={close} width="max-w-xl">
      {problem && <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />}
      <section className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-900">{t('automation.io.exportTitle')}</h4>
        <p className="text-xs text-gray-500">{t('automation.io.exportHint')}</p>
        <button className={secondaryButton} disabled={!workflow} onClick={() => void doExport()}>
          <Download className="w-4 h-4" />
          {t('automation.io.export')}
        </button>
      </section>
      <section className="space-y-2 border-t border-gray-100 pt-4">
        <h4 className="text-sm font-semibold text-gray-900">{t('automation.io.importTitle')}</h4>
        <p className="text-xs text-gray-500">{t('automation.io.importHint')}</p>
        <textarea
          className={`${inputClass} min-h-[140px] font-mono text-xs`}
          value={text}
          onChange={(event) => { setText(event.target.value); setPreview(null); }}
          placeholder={t('automation.io.pastePlaceholder')}
        />
        <div className="flex flex-wrap gap-2">
          <button className={secondaryButton} onClick={() => fileInput.current?.click()}>
            <Upload className="w-4 h-4" />
            {t('automation.io.pickFile')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setText(await file.text());
              setPreview(null);
            }}
          />
          <button className={primaryButton} disabled={!text.trim() || busy} onClick={() => void doPreview()}>{t('automation.io.preview')}</button>
        </div>
        {preview && (
          <InfoBanner>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{t('automation.io.confirmSummary', { name: preview.summary.name, nodes: preview.summary.nodes, edges: preview.summary.edges })}</span>
              <button className={primaryButton} disabled={busy} onClick={() => void doConfirm()}>{t('automation.io.confirm')}</button>
            </div>
          </InfoBanner>
        )}
      </section>
    </Modal>
  );
}
