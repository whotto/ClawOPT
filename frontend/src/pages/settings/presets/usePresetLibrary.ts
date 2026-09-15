// 角色预设库页签的全部状态与动作：预设装配、.clawpack 导入、导出与分享。
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useState } from 'react';
import { Boxes, Share2, Upload } from 'lucide-react';
import type { GroupSummary, InstallOutcome, InstallResult, PackInspection, Preset, Section, SessionSummary } from './presetTypes';
import { exportPack, inspectPack, installPack, installPreset, listPresets, type PackSource, sharePack } from '../../../api/presets';
import { listWorkflows } from '../../../api/automation';
import { listSessions } from '../../../api/sessions';
import { listGroups } from '../../../api/groups';

export function usePresetLibrary(onAgentsChanged?: () => void) {
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
  const [installWorkflows, setInstallWorkflows] = useState(true);
  const [importWorkflowResults, setImportWorkflowResults] = useState<Array<{ name: string; status: 'created' | 'failed'; errorCode?: string }> | null>(null);
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
  // 附带工作流（只带定义，不带模型绑定、附件与定时）
  const [workflowOptions, setWorkflowOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [exportWorkflowIds, setExportWorkflowIds] = useState<string[]>([]);
  const [exportBusy, setExportBusy] = useState<'download' | 'share' | null>(null);
  const [shareResult, setShareResult] = useState<{ gistUrl: string; rawUrl: string } | null>(null);
  const [copied, setCopied] = useState('');
  const [exportDone, setExportDone] = useState('');
  const [exportError, setExportError] = useState('');

  const activePreset = useMemo(() => presets.find(p => p.id === activeId) || null, [presets, activeId]);

  const loadPresets = async () => {
    setLoading(true);
    try {
      const res = await listPresets();
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

  useEffect(() => {
    listWorkflows()
      .then(res => res.json())
      .then(data => setWorkflowOptions(Array.isArray(data?.workflows) ? data.workflows.map((item: { id: string; name: string }) => ({ id: item.id, name: item.name })) : []))
      .catch(() => setWorkflowOptions([]));
  }, []);

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
      const res = await installPreset(activePreset.id, { roleIds: selectedRoles, params: paramValues, dryRun, overwrite });
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
        listSessions(),
        listGroups(),
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
      const res = await exportPack({ kind: exportKind, id: exportId, includeMemory, includeAutomations, includeModelConfig, includeWorkflows: exportWorkflowIds });
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
      const res = await sharePack({ kind: exportKind, id: exportId, includeMemory, includeAutomations, includeModelConfig, includeWorkflows: exportWorkflowIds });
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
  const buildPackSource = (extra?: Record<string, unknown>): PackSource => {
    if (packFile) {
      const form = new FormData();
      form.append('file', packFile);
      for (const [key, value] of Object.entries(extra || {})) {
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      return { kind: 'file', form };
    }
    return { kind: 'json', body: { url: packUrl.trim(), ...(extra || {}) } };
  };

  const runInspect = async () => {
    if (!packFile && !packUrl.trim()) return;
    setPackBusy('inspect');
    setPackError('');
    setImportResults(null);
    setImportTeamResult(null);
    setImportWorkflowResults(null);
    try {
      const res = await inspectPack(buildPackSource());
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
      const res = await installPack(buildPackSource({
        rename: renameMap,
        renameNames,
        overwrite: packOverwrite,
        applyModel,
        installWorkflows,
      }));
      const data = await res.json();
      if (!res.ok) {
        const localized = data?.errorCode ? t(data.errorCode, { ...(data.errorParams || {}) }) : t('settings.presets.installFailed');
        setPackError(typeof localized === 'string' ? localized : t('settings.presets.installFailed'));
        return;
      }
      setImportResults(Array.isArray(data?.results) ? data.results : []);
      setImportTeamResult(data?.team || null);
      setImportWorkflowResults(Array.isArray(data?.workflows) ? data.workflows : []);
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

  return {
    t,
    presets,
    setPresets,
    loading,
    setLoading,
    activeId,
    setActiveId,
    selectedRoles,
    setSelectedRoles,
    paramValues,
    setParamValues,
    overwrite,
    setOverwrite,
    busy,
    setBusy,
    results,
    setResults,
    resultsAreDryRun,
    setResultsAreDryRun,
    postInstall,
    setPostInstall,
    errorText,
    setErrorText,
    section,
    setSection,
    packFile,
    setPackFile,
    packUrl,
    setPackUrl,
    inspection,
    setInspection,
    renameMap,
    setRenameMap,
    renameNames,
    setRenameNames,
    packOverwrite,
    setPackOverwrite,
    applyModel,
    setApplyModel,
    importResults,
    setImportResults,
    importTeamResult,
    setImportTeamResult,
    installWorkflows,
    setInstallWorkflows,
    importWorkflowResults,
    packBusy,
    setPackBusy,
    packError,
    setPackError,
    exportKind,
    setExportKind,
    exportId,
    setExportId,
    exportSessions,
    setExportSessions,
    exportGroups,
    setExportGroups,
    includeMemory,
    setIncludeMemory,
    includeAutomations,
    setIncludeAutomations,
    includeModelConfig,
    setIncludeModelConfig,
    workflowOptions,
    exportWorkflowIds,
    setExportWorkflowIds,
    exportBusy,
    setExportBusy,
    shareResult,
    setShareResult,
    copied,
    setCopied,
    exportDone,
    setExportDone,
    exportError,
    setExportError,
    activePreset,
    loadPresets,
    toggleRole,
    runInstall,
    loadExportTargets,
    exportTargets,
    exportTargetName,
    runExport,
    runShare,
    copyToClipboard,
    buildPackSource,
    runInspect,
    runPackInstall,
    conflictCount,
    statusLabel,
    statusClass,
    sectionTabs,
  };
}

export type PresetLibraryController = ReturnType<typeof usePresetLibrary>;
