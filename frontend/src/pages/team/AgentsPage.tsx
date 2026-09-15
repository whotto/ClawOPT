// Agent 管理（团队区）：名册 + 头像、克隆（报告剥离项）、工作区身份文件、写入审批。
import { Copy, ImagePlus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rosterApi } from '../../api/control';
import { useShellContext } from '../../app/shellContext';
import { Badge, Button, Card, EmptyState, ErrorBanner, inputClass, labelClass, Modal, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { useAccess } from '../../app/access';
import { readApi, useErrorDisplay } from '../control/useControlApi';
import WorkspaceFilesEditor from './WorkspaceFilesEditor';
import WriteGatePanel from './WriteGatePanel';
import { openclawSessionsOnly } from '../../utils/openclawSessions';

type CloneReport = { copiedFiles: string[]; strippedBindings: Array<{ channel: string | null; accountId: string | null }> | null; skippedPrivate: string[]; credentialWarnings: string[]; avatarCopied: boolean };

const MAX_AVATAR_BYTES = 512 * 1024;

function AgentAvatar({ agentId, version, name }: { agentId: string; version: number | undefined; name: string }) {
  if (version === undefined) {
    return <div className="w-9 h-9 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-sm font-semibold text-gray-500 shrink-0">{name.slice(0, 1).toUpperCase()}</div>;
  }
  return <img src={rosterApi.avatarUrl(agentId, version)} alt="" className="w-9 h-9 rounded-full object-cover border border-gray-200 shrink-0" />;
}

function CloneModal({ agentId, agentName, onClose, onCloned }: { agentId: string; agentName: string; onClose: () => void; onCloned: (report: CloneReport) => void }) {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const [newAgentId, setNewAgentId] = useState(`${agentId}-copy`);
  const [name, setName] = useState(`${agentName} (copy)`);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await readApi<{ report: CloneReport }>(rosterApi.clone(agentId, { newAgentId: newAgentId.trim(), name: name.trim() }));
      if (result.ok) onCloned(result.data.report);
      else setError(errors.fromResult(result, 'control.agents.cloneFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('control.agents.cloneTitle', { name: agentName })} onClose={onClose} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" busy={saving} disabled={!newAgentId.trim()} onClick={submit}>{t('control.agents.clone')}</Button></>}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <Notice tone="blue">{t('control.agents.cloneHint')}</Notice>
      <label className="block">
        <span className={labelClass}>{t('control.agents.newAgentId')}</span>
        <input value={newAgentId} onChange={(event) => setNewAgentId(event.target.value)} className={`${inputClass} font-mono`} />
      </label>
      <label className="block">
        <span className={labelClass}>{t('control.agents.newAgentName')}</span>
        <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} maxLength={60} />
      </label>
    </Modal>
  );
}

export default function AgentsPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const shell = useShellContext();
  const isAdmin = useAccess().can('agents.manage');
  const [avatars, setAvatars] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<string>('');
  const [tab, setTab] = useState<'files' | 'writeGate'>('files');
  const [pendingCount, setPendingCount] = useState(0);
  const [cloning, setCloning] = useState(false);
  const [report, setReport] = useState<CloneReport | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [engineAgentIds, setEngineAgentIds] = useState<string[]>([]);

  // 统一名册：ClawOPT 会话里的 Agent + 只存在于引擎名册里的 Agent（用 `openclaw agents` 建的）。
  // 外部运行时单聊不是 OpenClaw Agent（没有工作区身份文件、头像、写入审批），不列：它们在侧栏里用自己的设置弹窗管理。
  const sessionAgents = openclawSessionsOnly(shell.sessions).map((session) => ({ id: session.agentId || session.id, name: session.name, engineOnly: false }));
  const known = new Set(sessionAgents.map((agent) => agent.id));
  const agents = [...sessionAgents, ...engineAgentIds.filter((id) => !known.has(id)).map((id) => ({ id, name: id, engineOnly: true }))];
  const current = agents.find((agent) => agent.id === selected) ?? agents[0];

  const loadAvatars = async () => {
    const result = await readApi<{ avatars: Array<{ agentId: string; updatedAt: number }> }>(rosterApi.avatars()).catch(() => null);
    if (result?.ok) setAvatars(Object.fromEntries(result.data.avatars.map((entry) => [entry.agentId, entry.updatedAt])));
  };

  useEffect(() => {
    void loadAvatars();
    readApi<{ agents: Array<{ id: string }> }>(rosterApi.engineAgents())
      .then((result) => { if (result.ok) setEngineAgentIds(result.data.agents.map((agent) => agent.id)); })
      .catch(() => undefined);
  }, []);

  const uploadAvatar = async (file: File) => {
    setError(null);
    if (file.size > MAX_AVATAR_BYTES) {
      setError({ message: t('agents.avatarTooLarge'), detail: '' });
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const result = await readApi(rosterApi.setAvatar(current.id, dataUrl)).catch(() => null);
    if (result && !result.ok) setError(errors.fromResult(result));
    void loadAvatars();
  };

  return (
    <div className="space-y-6">
      <PageIntro title={t('control.agents.title')} description={t('control.agents.description')} />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {report && (
        <Notice tone="green">
          <div className="space-y-1">
            <div className="font-semibold">{t('control.agents.clonedTitle')}</div>
            <div>{t('control.agents.clonedFiles', { count: report.copiedFiles.length })}</div>
            <div>{report.strippedBindings === null ? t('control.agents.bindingsUnknown') : t('control.agents.strippedBindings', { count: report.strippedBindings.length, list: report.strippedBindings.map((binding) => `${binding.channel ?? '?'}${binding.accountId ? `:${binding.accountId}` : ''}`).join(', ') || '—' })}</div>
            <div>{t('control.agents.skippedPrivate', { list: report.skippedPrivate.join(', ') })}</div>
            {report.credentialWarnings.length > 0 && <div>{t('control.agents.credentialWarnings', { list: report.credentialWarnings.join(', ') })}</div>}
          </div>
        </Notice>
      )}

      {agents.length === 0 ? <EmptyState>{t('control.agents.empty')}</EmptyState> : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4">
          <Card className="p-2 max-h-[40vh] lg:max-h-[75vh] overflow-y-auto">
            {agents.map((agent) => (
              <button key={agent.id} type="button" onClick={() => setSelected(agent.id)} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left border ${current?.id === agent.id ? 'bg-amber-50 border-orange-300' : 'border-transparent hover:bg-gray-50'}`}>
                <AgentAvatar agentId={agent.id} version={avatars[agent.id]} name={agent.name} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{agent.name}</div>
                  <div className="text-xs text-gray-400 font-mono truncate">{agent.id}</div>
                </div>
                {agent.engineOnly && <span className="ml-auto"><Badge>{t('control.agents.engineOnly')}</Badge></span>}
              </button>
            ))}
          </Card>

          {current && (
            <Card className="p-4 space-y-4 min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <AgentAvatar agentId={current.id} version={avatars[current.id]} name={current.name} />
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900 truncate">{current.name}</div>
                    <div className="text-xs text-gray-400 font-mono truncate">{current.id}</div>
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex flex-wrap gap-2">
                    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadAvatar(file); event.target.value = ''; }} />
                    <Button size="sm" onClick={() => fileInput.current?.click()}><ImagePlus className="w-3.5 h-3.5" />{t('control.agents.uploadAvatar')}</Button>
                    {avatars[current.id] !== undefined && <Button size="sm" onClick={() => void rosterApi.removeAvatar(current.id).then(loadAvatars)}><Trash2 className="w-3.5 h-3.5" />{t('control.agents.removeAvatar')}</Button>}
                    {/* 克隆以 ClawOPT 里的 Agent 为源（要复制它的会话设置）；只在引擎名册里的 Agent 先经「导入」纳入。 */}
                    {!current.engineOnly && <Button size="sm" onClick={() => setCloning(true)}><Copy className="w-3.5 h-3.5" />{t('control.agents.clone')}</Button>}
                  </div>
                )}
              </div>
              <div className="flex gap-2 border-b border-gray-100">
                {(['files', 'writeGate'] as const).map((key) => (
                  <button key={key} type="button" onClick={() => setTab(key)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === key ? 'border-blue-600 text-gray-900 font-semibold' : 'border-transparent text-gray-500'}`}>
                    {t(`control.agents.tab.${key}`)}
                    {key === 'writeGate' && pendingCount > 0 && <span className="ml-1.5"><Badge tone="amber">{pendingCount}</Badge></span>}
                  </button>
                ))}
              </div>
              {tab === 'files' ? <WorkspaceFilesEditor key={current.id} agentId={current.id} canEdit={isAdmin} /> : <WriteGatePanel key={current.id} agentId={current.id} canEdit={isAdmin} onCountChange={setPendingCount} />}
            </Card>
          )}
        </div>
      )}

      {cloning && current && (
        <CloneModal
          agentId={current.id}
          agentName={current.name}
          onClose={() => setCloning(false)}
          onCloned={(nextReport) => {
            setCloning(false);
            setReport(nextReport);
            void shell.reloadSessions();
            void loadAvatars();
          }}
        />
      )}
    </div>
  );
}
