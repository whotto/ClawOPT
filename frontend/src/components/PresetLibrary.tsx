import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Check, ChevronRight, Copy, Download, Link2, Loader2, RefreshCw, Share2, TriangleAlert, Upload } from 'lucide-react';

type PresetRole = {
  id: string;
  name: string;
  emoji: string;
  position: string;
  slogan: string;
  skills: string[];
  externalSkills: string[];
  recommended: boolean;
  note: string;
  installed: boolean;
};

type PresetParam = {
  key: string;
  label: string;
  hint: string;
  default: string;
  examples: string[];
};

type Preset = {
  id: string;
  broken?: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  author: string;
  roles: PresetRole[];
  params: PresetParam[];
  postInstall: string[];
};

type InstallResult = {
  roleId: string;
  name: string;
  emoji?: string;
  markdownChars: number;
  workspaceFileCount: number;
  skillNames: string[];
  externalSkills: string[];
  exists: boolean;
  status: 'willCreate' | 'willUpdate' | 'willSkip' | 'created' | 'updated' | 'skipped' | 'failed';
  error?: string;
};

type PackAgentInfo = {
  id: string;
  name: string;
  skills: string[];
  fileCount: number;
  hasAutomations: boolean;
  hasMemory: boolean;
  conflict: boolean;
  nameConflict: boolean;
  soulPreview: string;
};

type PackInspection = {
  kind: 'agent' | 'team';
  exportedAt: string;
  exportedBy?: { app?: string; version?: string };
  manifest: {
    name: string;
    summary: string;
    agentCount: number;
    skillCount: number;
    fileCount: number;
    totalBytes: number;
    includesMemory: boolean;
    includesAutomations: boolean;
    riskySkills: Array<{ agentId: string; skill: string; tools: string; exec: boolean; network: boolean }>;
    warnings: Array<{ code: string; detail?: string }>;
  };
  team: { id: string; name: string; conflict: boolean; members: Array<{ agentId: string }> } | null;
  agents: PackAgentInfo[];
};

type InstallOutcome = {
  sourceId: string;
  targetId: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  fileCount?: number;
  skills?: string[];
  error?: string;
};

type SessionSummary = { id: string; name: string };
type GroupSummary = { id: string; name: string; members?: Array<{ agent_id: string }> };
type Section = 'library' | 'import' | 'export';

interface PresetLibraryProps {
  onAgentsChanged?: () => void;
}

function buildHeaders(includeJson = false): HeadersInit {
  const headers: Record<string, string> = {};
  const authToken = localStorage.getItem('clawopt_auth_token');
  if (authToken && authToken !== 'disabled') {
    headers['X-ClawOPT-Auth-Token'] = authToken;
  }
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}

export default function PresetLibrary({ onAgentsChanged }: PresetLibraryProps) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string>('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [results, setResults] = useState<InstallResult[] | null>(null);
  const [resultsAreDryRun, setResultsAreDryRun] = useState(true);
  const [postInstall, setPostInstall] = useState<string[]>([]);
  const [errorText, setErrorText] = useState('');

  const [section, setSection] = useState<Section>('library');

  // 导入
  const [packFile, setPackFile] = useState<File | null>(null);
  const [packUrl, setPackUrl] = useState('');
  const [inspection, setInspection] = useState<PackInspection | null>(null);
  const [renameMap, setRenameMap] = useState<Record<string, string>>({});
  const [renameNames, setRenameNames] = useState<Record<string, string>>({});
  const [packOverwrite, setPackOverwrite] = useState(false);
  const [applyModel, setApplyModel] = useState(false);
  const [importResults, setImportResults] = useState<InstallOutcome[] | null>(null);
  const [importTeamResult, setImportTeamResult] = useState<any>(null);
  const [packBusy, setPackBusy] = useState<'inspect' | 'install' | null>(null);
  const [packError, setPackError] = useState('');

  // 导出
  const [exportKind, setExportKind] = useState<'agent' | 'team'>('agent');
  const [exportId, setExportId] = useState('');
  const [exportSessions, setExportSessions] = useState<SessionSummary[]>([]);
  const [exportGroups, setExportGroups] = useState<GroupSummary[]>([]);
  const [includeMemory, setIncludeMemory] = useState(false);
  const [includeAutomations, setIncludeAutomations] = useState(true);
  const [includeModelConfig, setIncludeModelConfig] = useState(false);
  const [exportBusy, setExportBusy] = useState<'download' | 'share' | null>(null);
  const [shareResult, setShareResult] = useState<{ gistUrl: string; rawUrl: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [exportDone, setExportDone] = useState('');
  const [exportError, setExportError] = useState('');

  const activePreset = useMemo(() => presets.find(p => p.id === activeId) || null, [presets, activeId]);

  const loadPresets = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/presets', { headers: buildHeaders() });
      const data = await res.json();
      const list: Preset[] = Array.isArray(data?.presets) ? data.presets : [];
      setPresets(list);
      if (list.length) {
        const first = list[0];
        setActiveId(prev => (prev && list.some(p => p.id === prev) ? prev : first.id));
      }
      setErrorText('');
    } catch (err: any) {
      setErrorText(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadPresets(); }, []);

  // 切换预设时重置选择：默认勾推荐角色、参数取默认值
  useEffect(() => {
    if (!activePreset) return;
    setSelectedRoles(activePreset.roles.filter(r => r.recommended).map(r => r.id));
    setParamValues(Object.fromEntries(activePreset.params.map(p => [p.key, p.default])));
    setResults(null);
    setPostInstall([]);
  }, [activeId, presets.length]);

  const toggleRole = (roleId: string) => {
    setSelectedRoles(prev => (prev.includes(roleId) ? prev.filter(id => id !== roleId) : [...prev, roleId]));
    setResults(null);
  };

  const runInstall = async (dryRun: boolean) => {
    if (!activePreset || !selectedRoles.length) return;
    setBusy(dryRun ? 'preview' : 'install');
    setErrorText('');
    try {
      const res = await fetch(`/api/presets/${activePreset.id}/install`, {
        method: 'POST',
        headers: buildHeaders(true),
        body: JSON.stringify({ roleIds: selectedRoles, params: paramValues, dryRun, overwrite }),
      });
      const data = await res.json();
      if (!res.ok) {
        const localized = data?.errorCode ? t(data.errorCode, { ...(data.errorParams || {}) }) : t('settings.presets.installFailed');
        setErrorText(typeof localized === 'string' ? localized : t('settings.presets.installFailed'));
        return;
      }
      setResults(Array.isArray(data?.results) ? data.results : []);
      setResultsAreDryRun(Boolean(data?.dryRun));
      setPostInstall(Array.isArray(data?.postInstall) ? data.postInstall : []);
      if (!dryRun) {
        onAgentsChanged?.();
        loadPresets();
      }
    } catch (err: any) {
      setErrorText(err?.message || String(err));
    } finally {
      setBusy(null);
    }
  };

  // ── 导出 ──────────────────────────────────────────────────────────────
  const loadExportTargets = async () => {
    try {
      const [sessionsRes, groupsRes] = await Promise.all([
        fetch('/api/sessions', { headers: buildHeaders() }),
        fetch('/api/groups', { headers: buildHeaders() }),
      ]);
      const sessionsData = await sessionsRes.json();
      const groupsData = await groupsRes.json();
      setExportSessions(Array.isArray(sessionsData) ? sessionsData : []);
      setExportGroups(Array.isArray(groupsData?.groups) ? groupsData.groups : []);
    } catch {
      /* 列表拉不到不阻断页面，用户还能用导入 */
    }
  };

  useEffect(() => {
    loadExportTargets();
    // 侧边栏点了「导出」会把目标写在这里，进来直接落到导出面板
    try {
      const raw = localStorage.getItem('clawopt_pack_export');
      if (raw) {
        const pending = JSON.parse(raw) as { kind?: 'agent' | 'team'; id?: string };
        if (pending?.id) {
          setExportKind(pending.kind === 'team' ? 'team' : 'agent');
          setExportId(pending.id);
          setSection('export');
        }
        localStorage.removeItem('clawopt_pack_export');
      }
    } catch { /* 隐私模式下读不到就正常进页面 */ }
  }, []);

  const exportTargets = exportKind === 'agent' ? exportSessions : exportGroups;
  const exportTargetName = exportTargets.find(target => target.id === exportId)?.name || '';

  const runExport = async () => {
    if (!exportId) return;
    setExportBusy('download');
    setExportError('');
    setExportDone('');
    setShareResult(null);
    try {
      const res = await fetch('/api/packs/export', {
        method: 'POST',
        headers: buildHeaders(true),
        body: JSON.stringify({ kind: exportKind, id: exportId, includeMemory, includeAutomations, includeModelConfig }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const localized = data?.errorCode ? t(data.errorCode, { ...(data.errorParams || {}) }) : t('settings.presets.exportFailed');
        setExportError(typeof localized === 'string' ? localized : t('settings.presets.exportFailed'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${exportTargetName || exportId}.clawpack`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setExportDone(`${exportTargetName || exportId}.clawpack`);
    } catch (err: any) {
      setExportError(err?.message || String(err));
    } finally {
      setExportBusy(null);
    }
  };

  /** 上传成一个你自己账号下的私密 gist，换一条链接。托管在分享者自己那边。 */
  const runShare = async () => {
    if (!exportId) return;
    setExportBusy('share');
    setExportError('');
    setExportDone('');
    setShareResult(null);
    try {
      const res = await fetch('/api/packs/share', {
        method: 'POST',
        headers: buildHeaders(true),
        body: JSON.stringify({ kind: exportKind, id: exportId, includeMemory, includeAutomations, includeModelConfig }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        const localized = data?.errorCode ? t(data.errorCode, { ...(data.errorParams || {}) }) : t('settings.presets.shareFailed');
        const detail = typeof data?.errorDetail === 'string' && data.errorDetail ? ` (${data.errorDetail.slice(0, 200)})` : '';
        setExportError((typeof localized === 'string' ? localized : t('settings.presets.shareFailed')) + detail);
        return;
      }
      setShareResult({ gistUrl: data.gistUrl, rawUrl: data.rawUrl });
    } catch (err: any) {
      setExportError(err?.message || String(err));
    } finally {
      setExportBusy(null);
    }
  };

  const copyToClipboard = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => setCopied(''), 2000);
    } catch {
      // 浏览器不给剪贴板权限时，链接本身仍然显示在页面上，用户可以手动选中
    }
  };

  // ── 导入 ──────────────────────────────────────────────────────────────
  const buildPackRequest = (extra?: Record<string, unknown>): RequestInit => {
    if (packFile) {
      const form = new FormData();
      form.append('file', packFile);
      for (const [key, value] of Object.entries(extra || {})) {
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      return { method: 'POST', headers: buildHeaders(), body: form };
    }
    return { method: 'POST', headers: buildHeaders(true), body: JSON.stringify({ url: packUrl.trim(), ...(extra || {}) }) };
  };

  const runInspect = async () => {
    if (!packFile && !packUrl.trim()) return;
    setPackBusy('inspect');
    setPackError('');
    setImportResults(null);
    setImportTeamResult(null);
    try {
      const res = await fetch('/api/packs/inspect', buildPackRequest());
      const data = await res.json();
      if (!res.ok || !data?.success) {
        const localized = data?.errorCode ? t(data.errorCode, { ...(data.errorParams || {}) }) : t('settings.presets.packUnreadable');
        const detail = typeof data?.errorDetail === 'string' && data.errorDetail ? ` (${data.errorDetail})` : '';
        setPackError((typeof localized === 'string' ? localized : t('settings.presets.packUnreadable')) + detail);
        setInspection(null);
        return;
      }
      const inspected = data as PackInspection;
      setInspection(inspected);
      setRenameMap({});
      setRenameNames({});
    } catch (err: any) {
      setPackError(err?.message || String(err));
    } finally {
      setPackBusy(null);
    }
  };

  const runPackInstall = async () => {
    if (!inspection) return;
    setPackBusy('install');
    setPackError('');
    try {
      const res = await fetch('/api/packs/install', buildPackRequest({
        rename: renameMap,
        renameNames,
        overwrite: packOverwrite,
        applyModel,
      }));
      const data = await res.json();
      if (!res.ok) {
        const localized = data?.errorCode ? t(data.errorCode, { ...(data.errorParams || {}) }) : t('settings.presets.installFailed');
        setPackError(typeof localized === 'string' ? localized : t('settings.presets.installFailed'));
        return;
      }
      setImportResults(Array.isArray(data?.results) ? data.results : []);
      setImportTeamResult(data?.team || null);
      onAgentsChanged?.();
      loadExportTargets();
    } catch (err: any) {
      setPackError(err?.message || String(err));
    } finally {
      setPackBusy(null);
    }
  };

  const conflictCount = inspection
    ? inspection.agents.filter(agent => agent.conflict && !renameMap[agent.id]).length + (inspection.team?.conflict && !renameMap[`team:${inspection.team.id}`] ? 1 : 0)
    : 0;

  const statusLabel = (status: InstallResult['status']) => t(`settings.presets.status.${status}`);
  const statusClass = (status: InstallResult['status']) =>
    status === 'failed' ? 'text-red-600 bg-red-50 border-red-200'
      : status === 'skipped' || status === 'willSkip' ? 'text-gray-500 bg-gray-50 border-gray-200'
        : status === 'updated' || status === 'willUpdate' ? 'text-amber-700 bg-amber-50 border-amber-200'
          : 'text-emerald-700 bg-emerald-50 border-emerald-200';

  const sectionTabs: Array<{ id: Section; label: string; Icon: typeof Boxes }> = [
    { id: 'library', label: t('settings.presets.tabLibrary'), Icon: Boxes },
    { id: 'import', label: t('settings.presets.tabImport'), Icon: Upload },
    { id: 'export', label: t('settings.presets.tabExport'), Icon: Share2 },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-3">
        {sectionTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSection(tab.id)}
            className={`inline-flex items-center gap-2 px-4 py-2 text-sm rounded-xl border transition-all ${
              section === tab.id
                ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
            }`}
          >
            <tab.Icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {section === 'library' && loading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}
        </div>
      )}

      {section === 'library' && !loading && !presets.length && (
        <div className="bg-white p-6 rounded-2xl border border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.title')}</h3>
          <p className="text-sm text-gray-500">{t('settings.presets.empty')}</p>
        </div>
      )}

      {section === 'library' && !loading && presets.length > 0 && (
      <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.title')}</h3>
        <p className="text-sm text-gray-500">{t('settings.presets.description')}</p>
      </div>

      {presets.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {presets.map(preset => (
            <button
              key={preset.id}
              disabled={Boolean(preset.broken)}
              onClick={() => setActiveId(preset.id)}
              className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                preset.id === activeId
                  ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                  : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
              }`}
            >
              {preset.name}{preset.broken ? ' ⚠' : ''}
            </button>
          ))}
        </div>
      )}

      {activePreset && (
        <>
          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <div className="flex items-start gap-3">
              <Boxes className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-base font-semibold text-gray-900">{activePreset.name}</span>
                  {activePreset.version && <span className="text-xs text-gray-400">v{activePreset.version}</span>}
                </div>
                {activePreset.tagline && <p className="text-sm text-gray-600 mt-1">{activePreset.tagline}</p>}
                {activePreset.description && <p className="text-sm text-gray-500 mt-2 leading-relaxed">{activePreset.description}</p>}
                {activePreset.broken && (
                  <p className="text-sm text-red-600 mt-2">{t('settings.presets.presetBroken', { reason: activePreset.broken })}</p>
                )}
              </div>
            </div>
          </div>

          {/* 角色选择 */}
          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-sm font-medium text-gray-900">{t('settings.presets.rolesTitle')}</h4>
              <div className="flex gap-2 text-xs">
                <button className="text-gray-500 hover:text-gray-900" onClick={() => setSelectedRoles(activePreset.roles.map(r => r.id))}>
                  {t('settings.presets.selectAll')}
                </button>
                <span className="text-gray-300">|</span>
                <button className="text-gray-500 hover:text-gray-900" onClick={() => setSelectedRoles([])}>
                  {t('settings.presets.selectNone')}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {activePreset.roles.map(role => {
                const checked = selectedRoles.includes(role.id);
                return (
                  <label
                    key={role.id}
                    className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                      checked ? 'bg-amber-50 border-orange-300' : 'bg-white border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleRole(role.id)} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">{role.emoji} {role.name}</span>
                        {role.position && <span className="text-xs text-gray-400">{role.position}</span>}
                        {role.installed && (
                          <span className="text-xs px-2 py-0.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-500">
                            {t('settings.presets.alreadyInstalled')}
                          </span>
                        )}
                      </div>
                      {role.slogan && <p className="text-xs text-gray-500 mt-1">{role.slogan}</p>}
                      <p className="text-xs text-gray-400 mt-1">
                        {t('settings.presets.skillCount', { count: role.skills.length })}
                        {role.externalSkills.length > 0 && ` · ${t('settings.presets.externalCount', { count: role.externalSkills.length })}`}
                      </p>
                      {role.note && <p className="text-xs text-gray-400 mt-1 leading-relaxed">{role.note}</p>}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* 参数 */}
          {activePreset.params.length > 0 && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
              <h4 className="text-sm font-medium text-gray-900">{t('settings.presets.paramsTitle')}</h4>
              {activePreset.params.map(param => (
                <div key={param.key}>
                  <label className="block text-sm font-medium text-gray-900 mb-1">{param.label}</label>
                  {param.hint && <p className="text-xs text-gray-500 mb-2">{param.hint}</p>}
                  <input
                    type="text"
                    value={paramValues[param.key] ?? ''}
                    placeholder={param.default}
                    onChange={e => { setParamValues(prev => ({ ...prev, [param.key]: e.target.value })); setResults(null); }}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-orange-300"
                  />
                  {param.examples.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {param.examples.map(example => (
                        <button
                          key={example}
                          onClick={() => { setParamValues(prev => ({ ...prev, [param.key]: example })); setResults(null); }}
                          className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
                        >
                          {example}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 动作 */}
          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <label className="flex items-start gap-2 text-sm text-gray-600 mb-4">
              <input type="checkbox" checked={overwrite} onChange={e => { setOverwrite(e.target.checked); setResults(null); }} className="mt-1" />
              <span>
                {t('settings.presets.overwriteLabel')}
                <span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.overwriteHint')}</span>
              </span>
            </label>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => runInstall(true)}
                disabled={!selectedRoles.length || busy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'preview' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
                {t('settings.presets.preview')}
              </button>
              <button
                onClick={() => runInstall(false)}
                disabled={!selectedRoles.length || busy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {busy === 'install' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('settings.presets.install', { count: selectedRoles.length })}
              </button>
              <button
                onClick={loadPresets}
                disabled={busy !== null}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm rounded-xl text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw className="w-4 h-4" />
                {t('settings.presets.refresh')}
              </button>
            </div>

            {errorText && (
              <div className="mt-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{errorText}</span>
              </div>
            )}
          </div>

          {/* 结果 */}
          {results && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">
                {resultsAreDryRun ? t('settings.presets.previewTitle') : t('settings.presets.resultTitle')}
              </h4>
              <div className="space-y-2">
                {results.map(result => (
                  <div key={result.roleId} className="flex items-start gap-3 p-3 rounded-xl border border-gray-200">
                    <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${statusClass(result.status)}`}>
                      {statusLabel(result.status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{result.emoji} {result.name}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        {t('settings.presets.resultDetail', {
                          chars: result.markdownChars,
                          files: result.workspaceFileCount,
                          skills: result.skillNames.length,
                        })}
                      </p>
                      {result.skillNames.length > 0 && (
                        <p className="text-xs text-gray-400 mt-1 break-words">{result.skillNames.join(' · ')}</p>
                      )}
                      {result.externalSkills.length > 0 && (
                        <p className="text-xs text-amber-600 mt-1 break-words">
                          {t('settings.presets.externalPending', { list: result.externalSkills.join(' · ') })}
                        </p>
                      )}
                      {result.error && <p className="text-xs text-red-600 mt-1 break-words">{result.error}</p>}
                    </div>
                  </div>
                ))}
              </div>

              {!resultsAreDryRun && postInstall.length > 0 && (
                <div className="mt-4 border-t border-gray-100 pt-4">
                  <p className="text-sm font-medium text-gray-900 mb-2">{t('settings.presets.nextSteps')}</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-gray-600">
                    {postInstall.map((step, index) => <li key={index}>{step}</li>)}
                  </ol>
                </div>
              )}
            </div>
          )}
        </>
      )}
      </div>
      )}

      {/* ── 导入一个包 ────────────────────────────────────────────── */}
      {section === 'import' && (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.importTitle')}</h3>
            <p className="text-sm text-gray-500">{t('settings.presets.importDescription')}</p>
          </div>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.presets.pickFile')}</label>
              <input
                type="file"
                accept=".clawpack,application/gzip"
                onChange={e => { setPackFile(e.target.files?.[0] || null); setPackUrl(''); setInspection(null); setImportResults(null); setPackError(''); }}
                className="block w-full text-sm text-gray-600 file:mr-4 file:px-4 file:py-2 file:rounded-xl file:border file:border-gray-200 file:bg-gray-50 file:text-sm file:text-gray-700 hover:file:bg-gray-100"
              />
              {packFile && <p className="text-xs text-gray-400 mt-1.5">{packFile.name} · {Math.round(packFile.size / 1024)} KB</p>}
            </div>

            <div className="flex items-center gap-3 text-xs text-gray-400">
              <span className="flex-1 h-px bg-gray-200" />{t('settings.presets.or')}<span className="flex-1 h-px bg-gray-200" />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.presets.pasteUrl')}</label>
              <input
                type="text"
                value={packUrl}
                placeholder="https://..."
                onChange={e => { setPackUrl(e.target.value); setPackFile(null); setInspection(null); setImportResults(null); setPackError(''); }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:border-orange-300"
              />
              <p className="text-xs text-gray-400 mt-1.5">{t('settings.presets.pasteUrlHint')}</p>
            </div>

            <button
              onClick={runInspect}
              disabled={(!packFile && !packUrl.trim()) || packBusy !== null}
              className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {packBusy === 'inspect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
              {t('settings.presets.inspect')}
            </button>

            {packError && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{packError}</span>
              </div>
            )}
          </div>

          {inspection && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
              <div>
                <p className="text-base font-semibold text-gray-900">{inspection.manifest.name}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {t('settings.presets.packMeta', {
                    kind: t(`settings.presets.kind.${inspection.kind}`),
                    agents: inspection.manifest.agentCount,
                    skills: inspection.manifest.skillCount,
                    files: inspection.manifest.fileCount,
                    size: Math.round(inspection.manifest.totalBytes / 1024),
                  })}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {t('settings.presets.packFrom', {
                    app: inspection.exportedBy?.app || 'ClawOPT',
                    version: inspection.exportedBy?.version || '',
                    date: (inspection.exportedAt || '').slice(0, 10),
                  })}
                </p>
              </div>

              {/* 装之前必须看清楚的东西 */}
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                <p className="text-sm font-medium text-amber-900">{t('settings.presets.beforeYouInstall')}</p>
                <ul className="text-xs text-amber-800 space-y-1 list-disc list-inside">
                  {inspection.manifest.riskySkills.filter(skill => skill.exec).length > 0 && (
                    <li>{t('settings.presets.warnExec', { list: inspection.manifest.riskySkills.filter(s => s.exec).map(s => s.skill).join(' · ') })}</li>
                  )}
                  {inspection.manifest.riskySkills.filter(skill => !skill.exec && skill.network).length > 0 && (
                    <li>{t('settings.presets.warnNetwork', { count: inspection.manifest.riskySkills.filter(s => !s.exec && s.network).length })}</li>
                  )}
                  {inspection.manifest.includesAutomations && <li>{t('settings.presets.warnAutomations')}</li>}
                  {inspection.manifest.includesMemory && <li>{t('settings.presets.warnMemory')}</li>}
                  {inspection.manifest.warnings.map((warning, index) => (
                    <li key={index}>{warning.code}{warning.detail ? ` — ${warning.detail}` : ''}</li>
                  ))}
                  <li>{t('settings.presets.warnPromptContent')}</li>
                </ul>
              </div>

              <div className="space-y-2">
                {inspection.agents.map(agent => (
                  <div key={agent.id} className="p-3 rounded-xl border border-gray-200">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">{agent.name}</span>
                      <span className="text-xs text-gray-400">{agent.id}</span>
                      {agent.conflict && (
                        <span className="text-xs px-2 py-0.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
                          {t('settings.presets.conflict')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {t('settings.presets.wroteFiles', { files: agent.fileCount, skills: agent.skills.length })}
                    </p>
                    {agent.skills.length > 0 && <p className="text-xs text-gray-400 mt-1 break-words">{agent.skills.join(' · ')}</p>}
                    {agent.conflict && (
                      <input
                        type="text"
                        value={renameMap[agent.id] ?? ''}
                        placeholder={t('settings.presets.renamePlaceholder', { id: agent.id })}
                        onChange={e => setRenameMap(prev => ({ ...prev, [agent.id]: e.target.value }))}
                        className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-300"
                      />
                    )}
                    {(() => {
                      const savingAsCopy = Boolean(renameMap[agent.id]?.trim());
                      // 只有「确实会多出一条同名智能体」时才提示：覆盖同一个 ID 不会。
                      const wouldDuplicate = agent.nameConflict && (savingAsCopy || !agent.conflict);
                      if (!wouldDuplicate) return null;
                      return (
                        <>
                          <input
                            type="text"
                            value={renameNames[agent.id] ?? `${agent.name}${t('settings.presets.importedSuffix')}`}
                            placeholder={agent.name}
                            onChange={e => setRenameNames(prev => ({ ...prev, [agent.id]: e.target.value }))}
                            className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-300"
                          />
                          <p className="text-xs text-amber-600 mt-1">{t('settings.presets.nameConflictHint', { name: agent.name })}</p>
                        </>
                      );
                    })()}
                  </div>
                ))}
              </div>

              {inspection.team && (
                <div className="p-3 rounded-xl border border-gray-200">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900">{inspection.team.name}</span>
                    <span className="text-xs text-gray-400">{inspection.team.id}</span>
                    {inspection.team.conflict && (
                      <span className="text-xs px-2 py-0.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-700">
                        {t('settings.presets.conflict')}
                      </span>
                    )}
                  </div>
                  {inspection.team.conflict && (
                    <input
                      type="text"
                      value={renameMap[`team:${inspection.team.id}`] ?? ''}
                      placeholder={t('settings.presets.renamePlaceholder', { id: inspection.team.id })}
                      onChange={e => setRenameMap(prev => ({ ...prev, [`team:${inspection.team!.id}`]: e.target.value }))}
                      className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-orange-300"
                    />
                  )}
                </div>
              )}

              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={packOverwrite} onChange={e => setPackOverwrite(e.target.checked)} className="mt-1" />
                <span>
                  {t('settings.presets.overwriteLabel')}
                  <span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.overwriteHint')}</span>
                </span>
              </label>

              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={applyModel} onChange={e => setApplyModel(e.target.checked)} className="mt-1" />
                <span>
                  {t('settings.presets.applyModelLabel')}
                  <span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.applyModelHint')}</span>
                </span>
              </label>

              {conflictCount > 0 && !packOverwrite && (
                <p className="text-xs text-amber-700">{t('settings.presets.conflictHint', { count: conflictCount })}</p>
              )}

              <button
                onClick={runPackInstall}
                disabled={packBusy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {packBusy === 'install' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                {t('settings.presets.installPack')}
              </button>
            </div>
          )}

          {importResults && (
            <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
              <h4 className="text-sm font-medium text-gray-900 mb-3">{t('settings.presets.resultTitle')}</h4>
              <div className="space-y-2">
                {importResults.map(result => (
                  <div key={result.sourceId} className="flex items-start gap-3 p-3 rounded-xl border border-gray-200">
                    <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${statusClass(result.status)}`}>
                      {statusLabel(result.status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">
                        {result.sourceId}{result.targetId !== result.sourceId ? ` → ${result.targetId}` : ''}
                      </p>
                      {typeof result.fileCount === 'number' && (
                        <p className="text-xs text-gray-500 mt-1">{t('settings.presets.wroteFiles', { files: result.fileCount, skills: result.skills?.length || 0 })}</p>
                      )}
                      {result.error && <p className="text-xs text-red-600 mt-1 break-words">{result.error}</p>}
                    </div>
                  </div>
                ))}
                {importTeamResult && (
                  <div className="flex items-start gap-3 p-3 rounded-xl border border-gray-200">
                    <span className={`text-xs px-2 py-1 rounded-lg border shrink-0 ${statusClass(importTeamResult.status)}`}>
                      {statusLabel(importTeamResult.status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900">{importTeamResult.targetId}</p>
                      <p className="text-xs text-gray-500 mt-1">{t('settings.presets.teamMembers', { count: importTeamResult.memberCount || 0 })}</p>
                    </div>
                  </div>
                )}
              </div>
              {inspection?.manifest.includesAutomations && (
                <p className="text-xs text-gray-500 mt-4">{t('settings.presets.automationsNotRun')}</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 导出 ──────────────────────────────────────────────────── */}
      {section === 'export' && (
        <div className="space-y-6">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.exportTitle')}</h3>
            <p className="text-sm text-gray-500">{t('settings.presets.exportDescription')}</p>
          </div>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
            <div className="flex gap-2">
              {(['agent', 'team'] as const).map(kind => (
                <button
                  key={kind}
                  onClick={() => { setExportKind(kind); setExportId(''); setExportDone(''); }}
                  className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                    exportKind === kind
                      ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                      : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  {t(`settings.presets.kind.${kind}`)}
                </button>
              ))}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-900 mb-2">{t('settings.presets.pickTarget')}</label>
              <select
                value={exportId}
                onChange={e => { setExportId(e.target.value); setExportDone(''); }}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:border-orange-300"
              >
                <option value="">{t('settings.presets.pickTargetPlaceholder')}</option>
                {exportTargets.map(target => (
                  <option key={target.id} value={target.id}>{target.name} ({target.id})</option>
                ))}
              </select>
            </div>

            <div className="space-y-2 border-t border-gray-100 pt-4">
              <p className="text-sm font-medium text-gray-900">{t('settings.presets.includeTitle')}</p>
              <p className="text-xs text-gray-500">{t('settings.presets.includeAlways')}</p>
              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={includeAutomations} onChange={e => setIncludeAutomations(e.target.checked)} className="mt-1" />
                <span>{t('settings.presets.includeAutomations')}<span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.includeAutomationsHint')}</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={includeMemory} onChange={e => setIncludeMemory(e.target.checked)} className="mt-1" />
                <span>{t('settings.presets.includeMemory')}<span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.includeMemoryHint')}</span></span>
              </label>
              <label className="flex items-start gap-2 text-sm text-gray-600">
                <input type="checkbox" checked={includeModelConfig} onChange={e => setIncludeModelConfig(e.target.checked)} className="mt-1" />
                <span>{t('settings.presets.includeModel')}<span className="block text-xs text-gray-400 mt-0.5">{t('settings.presets.includeModelHint')}</span></span>
              </label>
              <p className="text-xs text-gray-400 pt-1">{t('settings.presets.neverIncluded')}</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={runExport}
                disabled={!exportId || exportBusy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
              >
                {exportBusy === 'download' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                {t('settings.presets.exportButton')}
              </button>
              <button
                onClick={runShare}
                disabled={!exportId || exportBusy !== null}
                className="inline-flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-medium rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {exportBusy === 'share' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                {t('settings.presets.shareButton')}
              </button>
            </div>
            <p className="text-xs text-gray-400">{t('settings.presets.shareHint')}</p>

            {shareResult && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                <p className="text-sm font-medium text-emerald-900">{t('settings.presets.shareDone')}</p>
                <p className="text-xs text-emerald-800">{t('settings.presets.shareSecretWarning')}</p>
                {[
                  { label: t('settings.presets.shareLinkForImport'), value: shareResult.rawUrl, tag: 'raw' },
                  { label: t('settings.presets.shareLinkGist'), value: shareResult.gistUrl, tag: 'gist' },
                ].map(row => (
                  <div key={row.tag}>
                    <p className="text-xs text-emerald-800 mb-1">{row.label}</p>
                    <div className="flex gap-2">
                      <input
                        readOnly
                        value={row.value}
                        onFocus={event => event.currentTarget.select()}
                        className="flex-1 min-w-0 px-3 py-1.5 text-xs font-mono bg-white border border-emerald-200 rounded-lg"
                      />
                      <button
                        onClick={() => copyToClipboard(row.value, row.tag)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-100"
                      >
                        {copied === row.tag ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied === row.tag ? t('settings.presets.copied') : t('settings.presets.copy')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {exportDone && (
              <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                <Check className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{t('settings.presets.exportDone', { file: exportDone })}</span>
              </div>
            )}

            {exportError && (
              <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                <TriangleAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span className="break-words">{exportError}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
