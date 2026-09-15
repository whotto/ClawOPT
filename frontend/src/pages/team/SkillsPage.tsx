// 技能浏览（团队区）：按 Agent 看技能、来源徽标、就绪情况、SKILL.md 详情、启停、安装 / 更新 / 校验、ClawHub 搜索。
import { CheckCircle2, Download, RefreshCw, Search, ShieldCheck, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { rosterApi, skillsApi } from '../../api/control';
import { Badge, Button, Card, EmptyState, ErrorBanner, inputClass, labelClass, LoadingRow, Modal, Notice, PageIntro, Toggle, type ErrorDisplay } from '../../components/control/ControlUi';
import { readApi, useCurrentUser, useErrorDisplay } from '../control/useControlApi';

type Skill = { name: string; description: string | null; emoji: string | null; source: string | null; bundled: boolean; eligible: boolean; disabled: boolean; blocked: boolean; missing: Record<string, string[]> };
type SkillDetail = Skill & { skillKey: string | null; markdown: string | null; requirements: Record<string, string[]> };
type SearchResult = { id: string | null; displayName: string | null; summary: string | null; reference: string | null; downloads: number | null };

function sourceTone(source: string | null): 'gray' | 'blue' | 'green' | 'amber' {
  if (!source) return 'gray';
  if (source.includes('bundled')) return 'gray';
  if (source.includes('workspace')) return 'green';
  if (source.includes('managed') || source.includes('clawhub')) return 'blue';
  return 'amber';
}

export default function SkillsPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const { isAdmin } = useCurrentUser();
  const [agents, setAgents] = useState<string[]>([]);
  const [agent, setAgent] = useState('');
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'ready' | 'missing' | 'disabled'>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null | 'loading'>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [acknowledgeRisk, setAcknowledgeRisk] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError(null);
    setSkills(null);
    try {
      const result = await readApi<{ skills: Skill[] }>(skillsApi.list(agent));
      if (result.ok) setSkills(result.data.skills);
      else {
        setSkills([]);
        setError(errors.fromResult(result, 'control.skills.loadFailed'));
      }
    } catch (exception) {
      setSkills([]);
      setError(errors.fromException(exception));
    }
  }, [agent, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    readApi<{ agents: Array<{ id: string }> }>(rosterApi.engineAgents()).then((result) => {
      if (result.ok) setAgents(result.data.agents.map((entry) => entry.id));
    }).catch(() => undefined);
  }, []);

  const visible = useMemo(() => (skills ?? []).filter((skill) => {
    if (filter === 'ready' && !skill.eligible) return false;
    if (filter === 'missing' && (skill.eligible || skill.disabled)) return false;
    if (filter === 'disabled' && !skill.disabled) return false;
    const needle = query.trim().toLowerCase();
    return !needle || `${skill.name} ${skill.description ?? ''}`.toLowerCase().includes(needle);
  }), [skills, filter, query]);

  const counts = useMemo(() => ({
    all: skills?.length ?? 0,
    ready: skills?.filter((skill) => skill.eligible).length ?? 0,
    missing: skills?.filter((skill) => !skill.eligible && !skill.disabled).length ?? 0,
    disabled: skills?.filter((skill) => skill.disabled).length ?? 0,
  }), [skills]);

  const run = async (key: string, request: () => Promise<Response>, onOk?: (data: Record<string, unknown>) => void) => {
    setBusy(key);
    setError(null);
    try {
      const result = await readApi<Record<string, unknown>>(request());
      if (result.ok) onOk?.(result.data);
      else setError(errors.fromResult(result));
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(null);
    }
  };

  const openDetail = async (skill: Skill) => {
    setDetail('loading');
    const result = await readApi<{ skill: SkillDetail }>(skillsApi.info(skill.name, agent)).catch(() => null);
    if (result?.ok) setDetail(result.data.skill);
    else {
      setDetail(null);
      if (result) setError(errors.fromResult(result));
    }
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('control.skills.title')}
        description={t('control.skills.description')}
        actions={(
          <>
            <Button onClick={() => void load()}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            {isAdmin && <Button busy={busy === 'update'} onClick={() => void run('update', () => skillsApi.update({ agentId: agent || undefined }), () => { setNotice(t('control.skills.updated')); void load(); })}><UploadCloud className="w-4 h-4" />{t('control.skills.updateAll')}</Button>}
            {isAdmin && <Button variant="primary" onClick={() => setInstallOpen(true)}><Download className="w-4 h-4" />{t('control.skills.install')}</Button>}
          </>
        )}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {notice && <Notice tone="green">{notice}</Notice>}
      <Notice tone="blue">{t('control.skills.reloadHint')}</Notice>

      <div className="flex flex-col md:flex-row gap-3">
        <select value={agent} onChange={(event) => setAgent(event.target.value)} className={`${inputClass} md:max-w-[220px]`}>
          <option value="">{t('control.skills.defaultAgent')}</option>
          {agents.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputClass} pl-9`} placeholder={t('control.skills.search')} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {(['all', 'ready', 'missing', 'disabled'] as const).map((key) => (
          <button key={key} type="button" onClick={() => setFilter(key)} className={`px-3 h-8 rounded-lg text-xs font-medium border ${filter === key ? 'bg-amber-50 border-orange-300 text-gray-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {t(`control.skills.filter.${key}`)} · {counts[key]}
          </button>
        ))}
      </div>

      {skills === null ? <LoadingRow /> : visible.length === 0 ? <EmptyState>{t('control.skills.empty')}</EmptyState> : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((skill) => (
            <button key={skill.name} type="button" onClick={() => void openDetail(skill)} className="text-left">
              <Card className="p-4 h-full hover:border-gray-300 transition-colors space-y-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-lg">{skill.emoji ?? '🧩'}</span>
                  <span className="font-semibold text-gray-900 truncate">{skill.name}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={sourceTone(skill.source)}>{skill.source ?? t('common.unknown')}</Badge>
                  {skill.disabled ? <Badge>{t('control.skills.disabled')}</Badge> : skill.eligible ? <Badge tone="green">{t('control.skills.ready')}</Badge> : <Badge tone="amber">{t('control.skills.missing')}</Badge>}
                  {skill.blocked && <Badge tone="red">{t('control.skills.blocked')}</Badge>}
                </div>
                {skill.description && <div className="text-sm text-gray-500 line-clamp-3">{skill.description}</div>}
                {!skill.eligible && Object.keys(skill.missing).length > 0 && (
                  <div className="text-xs text-amber-700 break-words">{Object.entries(skill.missing).map(([kind, items]) => `${kind}: ${items.join(', ')}`).join(' · ')}</div>
                )}
              </Card>
            </button>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={detail === 'loading' ? t('control.common.loading') : `${detail.emoji ?? ''} ${detail.name}`} onClose={() => setDetail(null)} width="max-w-3xl">
          {detail === 'loading' ? <LoadingRow /> : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={sourceTone(detail.source)}>{detail.source ?? t('common.unknown')}</Badge>
                {detail.eligible ? <Badge tone="green">{t('control.skills.ready')}</Badge> : <Badge tone="amber">{t('control.skills.missing')}</Badge>}
                {isAdmin && detail.skillKey && (
                  <span className="ml-auto flex items-center gap-2 text-sm text-gray-600">
                    {t('control.skills.enabledToggle')}
                    <Toggle
                      label={t('control.skills.enabledToggle')}
                      checked={!detail.disabled}
                      disabled={busy === 'toggle'}
                      onChange={(next) => void run('toggle', () => skillsApi.setEnabled(detail.skillKey as string, next), () => { setDetail({ ...detail, disabled: !next }); void load(); })}
                    />
                  </span>
                )}
              </div>
              {Object.keys(detail.requirements).length > 0 && (
                <div className="text-xs text-gray-500">{t('control.skills.requirements')}: {Object.entries(detail.requirements).map(([kind, items]) => `${kind}: ${items.join(', ')}`).join(' · ')}</div>
              )}
              {detail.markdown ? (
                <div className="prose prose-sm max-w-none border border-gray-200 rounded-xl p-4 overflow-x-auto">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.markdown}</ReactMarkdown>
                </div>
              ) : <div className="text-sm text-gray-400">{t('control.skills.noMarkdown')}</div>}
            </>
          )}
        </Modal>
      )}

      {installOpen && (
        <Modal
          title={t('control.skills.installTitle')}
          onClose={() => setInstallOpen(false)}
          footer={(
            <>
              <Button onClick={() => setInstallOpen(false)}>{t('common.cancel')}</Button>
              <Button busy={busy === 'verify'} disabled={!ref.trim()} onClick={() => void run('verify', () => skillsApi.verify({ ref: ref.trim(), agentId: agent || undefined }), (data) => setNotice(String(data.output ?? t('control.skills.verified'))))}><ShieldCheck className="w-4 h-4" />{t('control.skills.verify')}</Button>
              <Button variant="primary" busy={busy === 'install'} disabled={!ref.trim()} onClick={() => void run('install', () => skillsApi.install({ ref: ref.trim(), agentId: agent || undefined, acknowledgeRisk }), () => { setInstallOpen(false); setNotice(t('control.skills.installed')); void load(); })}><CheckCircle2 className="w-4 h-4" />{t('control.skills.install')}</Button>
            </>
          )}
        >
          <label className="block">
            <span className={labelClass}>{t('control.skills.ref')}</span>
            <input value={ref} onChange={(event) => setRef(event.target.value)} className={`${inputClass} font-mono`} placeholder="@owner/skill · git:https://github.com/o/r" />
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-600">
            <input type="checkbox" className="mt-1" checked={acknowledgeRisk} onChange={(event) => setAcknowledgeRisk(event.target.checked)} />
            {t('control.skills.acknowledgeRisk')}
          </label>
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <div className="flex gap-2">
              <input value={searchText} onChange={(event) => setSearchText(event.target.value)} className={inputClass} placeholder={t('control.skills.searchHub')} />
              <Button busy={busy === 'search'} disabled={!searchText.trim()} onClick={() => void run('search', () => skillsApi.search(searchText.trim()), (data) => setResults((data.results as SearchResult[]) ?? []))}><Search className="w-4 h-4" /></Button>
            </div>
            {results && (results.length === 0 ? <div className="text-sm text-gray-400">{t('control.skills.searchEmpty')}</div> : (
              <div className="divide-y divide-gray-100 border border-gray-200 rounded-xl">
                {results.map((item) => (
                  <button key={item.id ?? item.reference ?? item.displayName} type="button" onClick={() => item.reference && setRef(item.reference)} className="w-full text-left p-3 hover:bg-gray-50">
                    <div className="text-sm font-medium text-gray-900">{item.displayName} <span className="text-xs font-mono text-gray-400">{item.reference}</span></div>
                    {item.summary && <div className="text-xs text-gray-500 line-clamp-2">{item.summary}</div>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
