import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Check, ChevronRight, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';

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

  const statusLabel = (status: InstallResult['status']) => t(`settings.presets.status.${status}`);
  const statusClass = (status: InstallResult['status']) =>
    status === 'failed' ? 'text-red-600 bg-red-50 border-red-200'
      : status === 'skipped' || status === 'willSkip' ? 'text-gray-500 bg-gray-50 border-gray-200'
        : status === 'updated' || status === 'willUpdate' ? 'text-amber-700 bg-amber-50 border-amber-200'
          : 'text-emerald-700 bg-emerald-50 border-emerald-200';

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-10">
        <Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}
      </div>
    );
  }

  if (!presets.length) {
    return (
      <div className="bg-white p-6 rounded-2xl border border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.presets.title')}</h3>
        <p className="text-sm text-gray-500">{t('settings.presets.empty')}</p>
      </div>
    );
  }

  return (
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
              onClick={() => setActiveId(preset.id)}
              className={`px-4 py-2 text-sm rounded-xl border transition-all ${
                preset.id === activeId
                  ? 'font-semibold text-gray-900 bg-amber-50 border-orange-300'
                  : 'font-normal text-gray-600 bg-white border-gray-200 hover:bg-gray-50'
              }`}
            >
              {preset.name}
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
  );
}
