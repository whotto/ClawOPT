import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { writeComposerPrefill } from '../../../utils/composerPrefill';
import { Button, editorClass, inputClass } from './runtimeUi';

type Agent = { id: string; name: string };

/**
 * 「让 AI 诊断」：选一个 OpenClaw Agent，把结构化的排障提示词预填进它的单聊输入框，**不自动发送**。
 * 预填经 sessionStorage 一次性交给聊天页（utils/composerPrefill.ts）。
 */
export default function DiagnoseDialog({ agents, prompt, onClose }: { agents: Agent[]; prompt: string; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [agentId, setAgentId] = useState(() => agents.find((agent) => agent.id === 'main')?.id ?? agents[0]?.id ?? '');
  const [text, setText] = useState(prompt);
  const canOpen = useMemo(() => Boolean(agentId && text.trim()), [agentId, text]);

  const open = () => {
    if (!canOpen) return;
    writeComposerPrefill(agentId, text);
    onClose();
    navigate(`/chat/${encodeURIComponent(agentId)}`);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-white rounded-2xl border border-gray-200 flex flex-col max-h-[calc(100dvh-2rem)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">{t('runtimes.diagnose.title')}</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100" aria-label={t('common.close')}><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <p className="text-sm text-gray-500">{t('runtimes.diagnose.description')}</p>
          {agents.length === 0 ? (
            <div className="text-sm text-amber-700">{t('runtimes.diagnose.noAgents')}</div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('runtimes.diagnose.agent')}</label>
              <select className={inputClass} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('runtimes.diagnose.prompt')}</label>
            <textarea className={editorClass} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!canOpen} onClick={open}>{t('runtimes.diagnose.open')}</Button>
        </div>
      </div>
    </div>
  );
}
