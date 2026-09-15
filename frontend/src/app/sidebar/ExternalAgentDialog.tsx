import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { listMemberRuntimes } from '../../api/runtime';
import { createSession, deleteSession, updateSession } from '../../api/sessions';
import RuntimeSelectionFields from '../../components/runtime/RuntimeSelectionFields';
import {
  chatCapableRuntimes,
  cleanSelectionConfig,
  runtimeOptionLabel,
  type RuntimeOption,
  type RuntimeSelectionConfig,
} from '../../components/runtime/runtimeSelection';
import { MODAL_FIELD_LABEL_CLASS, MODAL_FORM_FONT_STYLE, MODAL_TEXT_INPUT_CLASS } from './sidebarTypes';

export type ExternalSessionSummary = { id: string; name: string; externalRuntime?: string; externalConfig?: RuntimeSelectionConfig };

/** 新会话 id：运行时名 + 随机后缀（与普通 Agent 同一个 id 空间，不能有空格）。 */
export function suggestExternalSessionId(runtime: string): string {
  return `${runtime}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 外部运行时单聊：这个会话的 Agent 是本机的一个编码类外部运行时（Claude Code / Codex / …），经运行协调器跑。
 * 创建：选运行时（带检测状态）、模式、模型、推理强度、工作目录；编辑：改名字与运行时配置，或删除会话。
 */
export default function ExternalAgentDialog({ session, onClose, onSaved, onDeleted }: {
  session?: ExternalSessionSummary | null;
  onClose: () => void;
  onSaved: (sessionId: string) => void | Promise<void>;
  onDeleted?: (sessionId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const editing = Boolean(session?.externalRuntime);
  const [options, setOptions] = useState<RuntimeOption[]>([]);
  const [runtime, setRuntime] = useState(session?.externalRuntime ?? '');
  const [name, setName] = useState(session?.name ?? '');
  const [config, setConfig] = useState<RuntimeSelectionConfig>(session?.externalConfig ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listMemberRuntimes().then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (cancelled || !res.ok || !Array.isArray(data.runtimes)) return;
      const cli = chatCapableRuntimes(data.runtimes);
      setOptions(cli);
      if (!runtime) setRuntime((cli.find((item) => item.available) ?? cli[0])?.id ?? '');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const option = useMemo(() => options.find((item) => item.id === runtime), [options, runtime]);

  const save = async () => {
    if (!runtime || !option) return;
    setBusy(true);
    setError(null);
    try {
      const externalConfig = cleanSelectionConfig(config, option);
      const res = editing && session
        ? await updateSession(session.id, { name: name.trim() || session.name, externalConfig })
        : await createSession({ id: suggestExternalSessionId(runtime), name: name.trim() || option.name, externalRuntime: runtime, externalConfig });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        setError(data.errorCode ? t(data.errorCode) : (data.error || t('sidebar.netError')));
        return;
      }
      await onSaved(data.session?.id ?? session?.id);
    } catch {
      setError(t('sidebar.netError'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const res = await deleteSession(session.id);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || t('sidebar.netError'));
        return;
      }
      await onDeleted?.(session.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={MODAL_FORM_FONT_STYLE}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl bg-white rounded-2xl border border-gray-200 flex flex-col max-h-[calc(100dvh-2rem)]" data-testid="external-agent-dialog">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{editing ? t('externalAgent.editTitle') : t('externalAgent.createTitle')}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{t('externalAgent.description')}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100" aria-label={t('common.close')}><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('externalAgent.runtime')}</label>
              <select className={MODAL_TEXT_INPUT_CLASS} value={runtime} disabled={editing} onChange={(event) => { setRuntime(event.target.value); setConfig({}); }}>
                {options.map((item) => <option key={item.id} value={item.id}>{runtimeOptionLabel(item, t)}</option>)}
              </select>
            </div>
            <div>
              <label className={MODAL_FIELD_LABEL_CLASS}>{t('externalAgent.name')}</label>
              <input className={MODAL_TEXT_INPUT_CLASS} value={name} onChange={(event) => setName(event.target.value)} placeholder={option?.name ?? ''} />
            </div>
          </div>
          {option ? <RuntimeSelectionFields option={option} config={config} onChange={setConfig} /> : <p className="text-sm text-gray-400">{t('runtimes.loading')}</p>}
          <p className="text-xs text-gray-400">{t('externalAgent.commandsHint')}</p>
          {error && <p className="text-sm text-red-600 break-all">{error}</p>}
        </div>
        <div className="px-5 py-4 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2">
          <div>
            {editing && (confirmDelete ? (
              <button type="button" disabled={busy} onClick={() => void remove()} className="h-9 px-4 rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">{t('externalAgent.confirmDelete')}</button>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="h-9 px-4 rounded-xl text-sm font-medium bg-white text-red-600 border border-red-200 hover:bg-red-50">{t('common.delete')}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="h-9 px-4 rounded-xl text-sm font-medium bg-white text-gray-700 border border-gray-200 hover:bg-gray-50">{t('common.cancel')}</button>
            <button type="button" disabled={busy || !option} onClick={() => void save()} className="h-9 px-4 rounded-xl text-sm font-medium bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50">
              {editing ? t('common.save') : t('externalAgent.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
