// 记忆（团队区，管理员）：按 Agent 看记忆卡片。图谱（默认，需选一个 Agent）与列表两种视图；状态过滤、搜索；
// 选中卡片看详情、按版本号编辑、软删除；「记住」由人显式写入。
import { BrainCircuit, List, Network, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rosterApi } from '../../api/control';
import { memoryApi } from '../../api/memory';
import { Badge, Button, Card, EmptyState, ErrorBanner, formatTime, inputClass, LoadingRow, NoPermissionState, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { MemoryDetailPanel } from '../../features/memory/MemoryDetailPanel';
import { MemoryGraphView } from '../../features/memory/MemoryGraphView';
import { scopeLabel, type MemoryCardView, type MemoryEdgeKind, type MemoryEdgeView } from '../../features/memory/memoryModel';
import { RememberModal } from '../../features/memory/RememberModal';
import { readApi, useErrorDisplay } from '../control/useControlApi';

type ViewMode = 'graph' | 'list';
const STATUSES = ['active', 'all', 'superseded', 'expired', 'deleted'] as const;
const PAGE_SIZE = 100;

export default function MemoryPage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [profiles, setProfiles] = useState<Array<{ profileId: string; active: number; total: number }>>([]);
  const [engineAgents, setEngineAgents] = useState<string[]>([]);
  const [storeInfo, setStoreInfo] = useState<{ ephemeral: boolean; fts: boolean } | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('active');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewMode>('graph');
  const [cards, setCards] = useState<MemoryCardView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [edges, setEdges] = useState<MemoryEdgeView[]>([]);
  const [enabledEdges, setEnabledEdges] = useState<Record<MemoryEdgeKind, boolean>>({ revision: true, source: true, entity: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [remembering, setRemembering] = useState(false);

  const loadProfiles = useCallback(async () => {
    try {
      const result = await readApi<{ profiles: typeof profiles; store: { ephemeral: boolean; fts: boolean } }>(memoryApi.profiles());
      if (result.status === 403) {
        setForbidden(true);
        return;
      }
      if (result.ok) {
        setProfiles(result.data.profiles);
        setStoreInfo(result.data.store);
        setProfileId((current) => current || result.data.profiles[0]?.profileId || '');
      }
    } catch (exception) {
      setError(errors.fromException(exception));
    }
    // 引擎名册只用来补全 Agent 选项（没有记忆的 Agent 也能「记住」）；拿不到不影响页面。
    readApi<{ agents: Array<{ id: string }> }>(rosterApi.engineAgents())
      .then((result) => { if (result.ok) setEngineAgents(result.data.agents.map((agent) => agent.id)); })
      .catch(() => undefined);
  }, [errors]);

  const load = useCallback(async () => {
    setCards(null);
    setError(null);
    try {
      // 图谱要选定 Agent；列表可以看全部。
      if (view === 'graph' && profileId) {
        const result = await readApi<{ cards: MemoryCardView[]; edges: MemoryEdgeView[]; truncated: boolean }>(memoryApi.graph(profileId, status === 'all' || status === 'deleted'));
        if (result.status === 403) return setForbidden(true);
        if (!result.ok) {
          setCards([]);
          return setError(errors.fromResult(result, 'memoryService.page.loadFailed'));
        }
        const needle = query.trim().toLowerCase();
        const filtered = result.data.cards.filter((card) => (status === 'all' || card.status === status)
          && (!needle || `${card.title} ${card.content} ${card.key} ${card.entities.join(' ')}`.toLowerCase().includes(needle)));
        setCards(filtered);
        setTotal(filtered.length);
        setEdges(result.data.edges);
        return undefined;
      }
      const result = await readApi<{ cards: MemoryCardView[]; total: number }>(memoryApi.list({ profileId: profileId || null, q: query, status, limit: PAGE_SIZE }));
      if (result.status === 403) return setForbidden(true);
      if (!result.ok) {
        setCards([]);
        return setError(errors.fromResult(result, 'memoryService.page.loadFailed'));
      }
      setCards(result.data.cards);
      setTotal(result.data.total);
      setEdges([]);
    } catch (exception) {
      setCards([]);
      setError(errors.fromException(exception));
    }
    return undefined;
    // 搜索词不进依赖：回车或刷新才查。
  }, [view, profileId, status, errors]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);
  useEffect(() => { void load(); }, [load]);

  const profileOptions = useMemo(() => [...new Set([...profiles.map((entry) => entry.profileId), ...engineAgents])].sort(), [profiles, engineAgents]);
  const selected = cards?.find((card) => card.id === selectedId) ?? null;

  if (forbidden) return <NoPermissionState />;

  const onChanged = (next: MemoryCardView | null) => {
    if (next) setSelectedId(next.id);
    void load();
    void loadProfiles();
  };

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('memoryService.page.title')}
        description={t('memoryService.page.description')}
        actions={(
          <>
            <Button onClick={() => { void loadProfiles(); void load(); }}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
            <Button variant="primary" onClick={() => setRemembering(true)}><Plus className="w-4 h-4" />{t('memoryService.page.remember')}</Button>
          </>
        )}
      />
      {storeInfo?.ephemeral && <Notice>{t('memoryService.page.ephemeralNotice')}</Notice>}
      {storeInfo && !storeInfo.fts && <Notice tone="blue">{t('memoryService.page.ftsUnavailableNotice')}</Notice>}
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <select value={profileId} onChange={(event) => { setProfileId(event.target.value); setSelectedId(null); }} className={inputClass} aria-label={t('memoryService.page.fieldProfile')}>
          {view === 'list' && <option value="">{t('memoryService.page.allProfiles')}</option>}
          {profileOptions.map((id) => {
            const counts = profiles.find((entry) => entry.profileId === id);
            return <option key={id} value={id}>{counts ? `${id} (${counts.active})` : id}</option>;
          })}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)} className={inputClass} aria-label={t('memoryService.page.statusFilter')}>
          {STATUSES.map((value) => <option key={value} value={value}>{t(`memoryService.page.status.${value}`)}</option>)}
        </select>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load(); }}
          className={inputClass}
          placeholder={t('memoryService.page.search')}
        />
        <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1 h-[42px] self-start">
          {([['graph', Network], ['list', List]] as const).map(([mode, Icon]) => (
            <button
              key={mode}
              type="button"
              onClick={() => { setView(mode); if (mode === 'graph' && !profileId && profileOptions[0]) setProfileId(profileOptions[0]); }}
              className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 rounded-lg text-sm ${view === mode ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              <Icon className="w-4 h-4" />
              {t(`memoryService.page.view.${mode}`)}
            </button>
          ))}
        </div>
      </div>

      {cards === null ? <LoadingRow /> : view === 'graph' && !profileId ? (
        <EmptyState>{t('memoryService.page.pickProfile')}</EmptyState>
      ) : cards.length === 0 ? (
        <EmptyState>
          <BrainCircuit className="w-6 h-6 mx-auto mb-2 text-gray-300" />
          {t('memoryService.page.empty')}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_22rem] gap-4 items-start">
          <div className="min-w-0 space-y-2">
            {view === 'graph' ? (
              <MemoryGraphView
                cards={cards}
                edges={edges}
                enabledEdges={enabledEdges}
                onToggleEdge={(kind) => setEnabledEdges((current) => ({ ...current, [kind]: !current[kind] }))}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            ) : (
              <Card className="overflow-hidden">
                <div className="divide-y divide-gray-100">
                  {cards.map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setSelectedId(card.id === selectedId ? null : card.id)}
                      className={`w-full text-left px-4 py-3 hover:bg-gray-50 ${card.id === selectedId ? 'bg-blue-50/60' : ''}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 break-words">{card.title}</span>
                        <Badge tone={card.status === 'active' ? 'green' : card.status === 'deleted' ? 'red' : 'gray'}>{t(`memoryService.page.status.${card.status}`)}</Badge>
                        <Badge>r{card.revision}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-gray-500 font-mono break-all">{card.profileId} · {scopeLabel(card.scope)} · {card.key}</div>
                      <div className="mt-1 text-sm text-gray-600 line-clamp-2 break-words">{card.content}</div>
                      <div className="mt-1 text-xs text-gray-400">{formatTime(Date.parse(card.updatedAt), i18n.language)}</div>
                    </button>
                  ))}
                </div>
              </Card>
            )}
            <div className="text-xs text-gray-400">{t('memoryService.page.count', { shown: cards.length, total })}</div>
          </div>
          {selected ? (
            <MemoryDetailPanel card={selected} onClose={() => setSelectedId(null)} onChanged={onChanged} />
          ) : (
            <div className="hidden xl:block text-sm text-gray-400 px-2 py-4">{t('memoryService.page.selectHint')}</div>
          )}
        </div>
      )}

      {remembering && (
        <RememberModal
          profileIds={profileOptions}
          defaultProfileId={profileId || null}
          onClose={() => setRemembering(false)}
          onSaved={() => {
            setRemembering(false);
            void loadProfiles();
            void load();
          }}
        />
      )}
    </div>
  );
}
