import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { listMemberRuntimes } from '../../../api/runtime';
import { createSession } from '../../../api/sessions';
import { chatCapableRuntimes, type RuntimeOption } from '../../../components/runtime/runtimeSelection';
import { writeComposerPrefill } from '../../../utils/composerPrefill';
import { Button, editorClass, inputClass } from '../../../components/control/ControlUi';
import { diagnoseSessionId, pickDiagnoseTarget, type DiagnoseAgent } from './runtimeLogic';

/** 诊断优先交给这两个编码类运行时（装了才出现）：它们能直接读日志、跑命令。 */
const DIAGNOSE_RUNTIMES = ['claude-code', 'codex'];

/**
 * 「让 AI 诊断」：选一个 Agent，把结构化的排障提示词预填进它的单聊输入框，**不自动发送**。
 * 可选项：已有的 OpenClaw Agent 与外部运行时单聊；本机装了 Claude Code / Codex 时，另给「新开一个它的诊断单聊」
 * （global 模式，用 CLI 自己的登录；同一个运行时复用同一个诊断会话）。预填经 sessionStorage 一次性交给聊天页。
 */
export default function DiagnoseDialog({ agents, prompt, onClose, onSessionsChanged }: {
  agents: DiagnoseAgent[];
  prompt: string;
  onClose: () => void;
  onSessionsChanged?: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [runtimes, setRuntimes] = useState<RuntimeOption[]>([]);
  const [target, setTarget] = useState(() => agents.find((agent) => agent.id === 'main')?.id ?? agents[0]?.id ?? '');
  const [text, setText] = useState(prompt);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listMemberRuntimes().then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (cancelled || !res.ok || !Array.isArray(data.runtimes)) return;
      const available = chatCapableRuntimes(data.runtimes).filter((item) => item.available && DIAGNOSE_RUNTIMES.includes(item.id));
      setRuntimes(available);
      // 装了 Claude Code / Codex 就默认交给它（排障要能跑命令、看文件）。
      if (available.length > 0) setTarget((prev) => (prev && prev.startsWith('runtime:') ? prev : `runtime:${available[0].id}`));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const canOpen = useMemo(() => Boolean(target && text.trim()), [target, text]);

  const open = async () => {
    if (!canOpen) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = pickDiagnoseTarget(target, agents);
      const sessionId = resolved.sessionId;
      if (resolved.createRuntime) {
        const option = runtimes.find((item) => item.id === resolved.createRuntime);
        const res = await createSession({
          id: diagnoseSessionId(resolved.createRuntime),
          name: t('runtimes.diagnose.sessionName', { runtime: option?.name ?? resolved.createRuntime }),
          externalRuntime: resolved.createRuntime,
          externalConfig: { mode: 'global' },
          // 会话来历：「只看人建的」筛选据此隐藏诊断会话。
          origin: 'diagnosis',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && data.errorCode !== 'agents.idAlreadyExists') {
          setError(data.errorCode ? t(data.errorCode) : (data.error || t('sidebar.netError')));
          return;
        }
        await onSessionsChanged?.();
      }
      writeComposerPrefill(sessionId, text);
      onClose();
      navigate(`/chat/${encodeURIComponent(sessionId)}`);
    } catch {
      setError(t('sidebar.netError'));
    } finally {
      setBusy(false);
    }
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
          {agents.length === 0 && runtimes.length === 0 ? (
            <div className="text-sm text-amber-700">{t('runtimes.diagnose.noAgents')}</div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('runtimes.diagnose.agent')}</label>
              <select className={inputClass} value={target} onChange={(event) => setTarget(event.target.value)} data-testid="diagnose-target">
                {runtimes.length > 0 && (
                  <optgroup label={t('runtimes.diagnose.externalGroup')}>
                    {runtimes.map((item) => <option key={item.id} value={`runtime:${item.id}`}>{t('runtimes.diagnose.externalOption', { runtime: item.name })}</option>)}
                  </optgroup>
                )}
                <optgroup label={t('runtimes.diagnose.agentsGroup')}>
                  {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                </optgroup>
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-1.5">{t('runtimes.diagnose.prompt')}</label>
            <textarea className={editorClass} value={text} onChange={(event) => setText(event.target.value)} />
          </div>
          {error && <p className="text-sm text-red-600 break-all">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!canOpen || busy} onClick={() => void open()}>{t('runtimes.diagnose.open')}</Button>
        </div>
      </div>
    </div>
  );
}
