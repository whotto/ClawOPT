// 成长轨迹（团队区）：一个 Agent 随时间记住了什么、学会了什么。节点来自工作区 MEMORY.md 的日期小节与每日记录、
// skills 目录（经写入审批落地的标「Agent 自己写的」）、记忆卡片；种类 / 类别 / 关键字过滤；时间回放逐个点亮节点。
import '@xyflow/react/dist/base.css';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { Pause, Play, RefreshCw, SkipBack } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { journeyApi } from '../../api/journey';
import { rosterApi } from '../../api/control';
import { Badge, Button, Card, EmptyState, ErrorBanner, inputClass, LoadingRow, NoPermissionState, Notice, PageIntro, formatTime, type ErrorDisplay } from '../../components/control/ControlUi';
import {
  DEFAULT_FILTER,
  JOURNEY_NODE_WIDTH,
  KIND_STYLE,
  filterNodes,
  layoutJourney,
  neighborsOf,
  visibleAtStep,
  visibleEdges,
  type JourneyFilter,
  type JourneyGraphView,
  type JourneyNodeKind,
  type JourneyNodeView,
} from '../../features/journey/journeyModel';
import { readApi, useErrorDisplay } from '../control/useControlApi';

const KINDS: JourneyNodeKind[] = ['memory', 'daily', 'skill', 'card'];
const PLAY_INTERVAL_MS = 600;

type NodeData = { node: JourneyNodeView; dimmed: boolean; selected: boolean; byLabel: string | null };

function JourneyNode({ data }: NodeProps<Node<NodeData>>) {
  const style = KIND_STYLE[data.node.kind];
  return (
    <div
      className={`rounded-xl border px-3 py-2 text-left transition-opacity ${data.dimmed ? 'opacity-30' : 'opacity-100'}`}
      style={{ width: JOURNEY_NODE_WIDTH, background: style.fill, borderColor: data.selected ? '#2a55b8' : style.border, borderWidth: data.selected ? 2 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="!w-1 !h-1 !min-w-0 !border-0 !bg-transparent" />
      <div className="text-xs font-semibold text-gray-900 truncate">{data.node.label}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-gray-500">
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: style.dot }} />
        <span className="font-mono">{data.node.timestamp.slice(0, 10)}</span>
        {data.byLabel && <span className="truncate">{data.byLabel}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!w-1 !h-1 !min-w-0 !border-0 !bg-transparent" />
    </div>
  );
}

const nodeTypes = { journey: JourneyNode };

export default function JourneyPage() {
  const { t, i18n } = useTranslation();
  const errors = useErrorDisplay();
  const [agents, setAgents] = useState<Array<{ id: string }> | null>(null);
  const [agentId, setAgentId] = useState<string>('');
  const [graph, setGraph] = useState<JourneyGraphView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [filter, setFilter] = useState<JourneyFilter>(DEFAULT_FILTER);
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    readApi<{ agents: Array<{ id: string }> }>(rosterApi.engineAgents())
      .then((result) => {
        if (result.status === 403) {
          setForbidden(true);
          return;
        }
        const list = result.ok ? result.data.agents : [];
        setAgents(list);
        if (!result.ok) setError(errors.fromResult(result, 'journey.loadFailed'));
        setAgentId((current) => current || list[0]?.id || '');
      })
      .catch((exception) => {
        setAgents([]);
        setError(errors.fromException(exception));
      });
  }, [errors]);

  const load = useCallback(async () => {
    if (!agentId) return;
    setLoading(true);
    setError(null);
    setPlaying(false);
    setStep(null);
    setSelectedId(null);
    try {
      const result = await readApi<{ graph: JourneyGraphView }>(journeyApi.graph(agentId));
      if (result.ok) setGraph(result.data.graph);
      else {
        setGraph(null);
        setError(errors.fromResult(result, 'journey.loadFailed'));
      }
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setLoading(false);
    }
  }, [agentId, errors]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => (graph ? filterNodes(graph.nodes, filter) : []), [graph, filter]);
  const visible = useMemo(() => visibleAtStep(filtered, step), [filtered, step]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = window.setInterval(() => {
      setStep((current) => {
        const next = (current ?? 0) + 1;
        if (next >= filtered.length) {
          setPlaying(false);
          return filtered.length;
        }
        return next;
      });
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, filtered.length]);

  const layout = useMemo(() => layoutJourney(filtered), [filtered]);
  const edgesShown = useMemo(() => (graph ? visibleEdges(graph.edges, visible) : []), [graph, visible]);
  const highlight = useMemo(() => neighborsOf(edgesShown, selectedId), [edgesShown, selectedId]);

  const byLabel = (node: JourneyNodeView) => (node.createdBy === 'agent' ? t('journey.byAgent') : node.createdBy === 'pending' ? t('journey.byPending') : node.kind === 'skill' ? t('journey.byUnknown') : null);

  const flowNodes: Node<NodeData>[] = filtered.filter((node) => visible.has(node.id)).map((node) => ({
    id: node.id,
    type: 'journey',
    position: layout.get(node.id) ?? { x: 0, y: 0 },
    data: { node, dimmed: selectedId !== null && !highlight.has(node.id), selected: node.id === selectedId, byLabel: byLabel(node) },
    draggable: false,
  }));
  const flowEdges: Edge[] = edgesShown.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: step !== null && playing,
    style: { stroke: edge.kind === 'revision' ? '#a8700f' : edge.kind === 'mentions' ? '#2f8578' : '#c2c7d0', strokeWidth: 1.2, opacity: selectedId && !(highlight.has(edge.source) && highlight.has(edge.target)) ? 0.2 : 1 },
  }));

  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;

  if (forbidden) return <NoPermissionState />;

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('journey.title')}
        description={t('journey.description')}
        actions={<Button onClick={() => void load()} busy={loading} disabled={!agentId}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {agents === null ? <LoadingRow /> : agents.length === 0 ? <EmptyState>{t('journey.noAgents')}</EmptyState> : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className={inputClass} aria-label={t('journey.agent')}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
            </select>
            <select value={filter.category ?? ''} onChange={(event) => { setStep(null); setFilter((current) => ({ ...current, category: event.target.value || null })); }} className={inputClass} aria-label={t('journey.category')}>
              <option value="">{t('journey.allCategories')}</option>
              {(graph?.clusters ?? []).map((cluster) => <option key={cluster.category} value={cluster.category}>{cluster.category} ({cluster.count})</option>)}
            </select>
            <input value={filter.query} onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))} className={`${inputClass} lg:col-span-2`} placeholder={t('journey.search')} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={filter.kinds[kind]}
                onClick={() => { setStep(null); setFilter((current) => ({ ...current, kinds: { ...current.kinds, [kind]: !current.kinds[kind] } })); }}
                className={`h-8 px-3 rounded-full border text-xs font-medium inline-flex items-center gap-1.5 ${filter.kinds[kind] ? 'border-gray-300 bg-white text-gray-800' : 'border-gray-200 bg-gray-50 text-gray-400'}`}
              >
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: KIND_STYLE[kind].dot }} />
                {t(`journey.kind.${kind}`)}
              </button>
            ))}
            <div className="flex-1" />
            <Button size="sm" onClick={() => { setPlaying(false); setStep(0); }} disabled={!filtered.length}><SkipBack className="w-3.5 h-3.5" />{t('journey.restart')}</Button>
            <Button size="sm" variant={playing ? 'secondary' : 'primary'} disabled={!filtered.length} onClick={() => {
              if (playing) setPlaying(false);
              else {
                if (step === null || step >= filtered.length) setStep(0);
                setPlaying(true);
              }
            }}>
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {playing ? t('journey.pause') : t('journey.play')}
            </Button>
            {step !== null && <Button size="sm" variant="ghost" onClick={() => { setPlaying(false); setStep(null); }}>{t('journey.showAll')}</Button>}
          </div>
          {step !== null && filtered.length > 0 && (
            <input type="range" min={0} max={filtered.length} value={step} onChange={(event) => { setPlaying(false); setStep(Number(event.target.value)); }} className="w-full accent-blue-600" aria-label={t('journey.timeline')} />
          )}
          {graph && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge>{t('journey.statMemory', { count: graph.stats.memory + graph.stats.daily })}</Badge>
              <Badge tone="green">{t('journey.statSkills', { count: graph.stats.skills, agent: graph.stats.agentSkills })}</Badge>
              <Badge tone="amber">{t('journey.statCards', { count: graph.stats.cards })}</Badge>
              {graph.stats.first && <span className="text-gray-500">{formatTime(Date.parse(graph.stats.first), i18n.language)} → {graph.stats.last ? formatTime(Date.parse(graph.stats.last), i18n.language) : ''}</span>}
            </div>
          )}
          {graph && !graph.workspaceAvailable && <Notice tone="blue">{t('journey.noWorkspace')}</Notice>}
          {graph?.truncated && <Notice>{t('journey.truncated')}</Notice>}
          {loading && !graph ? <LoadingRow /> : !graph || graph.nodes.length === 0 ? <EmptyState>{t('journey.empty')}</EmptyState> : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
              <Card className="h-[60vh] min-h-[360px] overflow-hidden">
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={flowNodes}
                    edges={flowEdges}
                    nodeTypes={nodeTypes}
                    fitView
                    minZoom={0.2}
                    nodesConnectable={false}
                    onNodeClick={(_event, node) => setSelectedId(node.id)}
                    onPaneClick={() => setSelectedId(null)}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background gap={24} size={1} color="#dcdfe5" />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                </ReactFlowProvider>
              </Card>
              <Card className="p-4 space-y-3 h-fit">
                {!selected ? <div className="text-sm text-gray-400">{t('journey.selectHint')}</div> : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: KIND_STYLE[selected.kind].dot }} />
                      <span className="text-xs text-gray-500">{t(`journey.kind.${selected.kind}`)}</span>
                      {byLabel(selected) && <Badge tone={selected.createdBy === 'agent' ? 'green' : selected.createdBy === 'pending' ? 'amber' : 'gray'}>{byLabel(selected)}</Badge>}
                    </div>
                    <div className="text-sm font-semibold text-gray-900 break-words">{selected.label}</div>
                    <dl className="text-xs text-gray-500 space-y-1">
                      <div><dt className="inline">{t('journey.at')}：</dt><dd className="inline font-mono">{formatTime(Date.parse(selected.timestamp), i18n.language)}</dd></div>
                      {selected.modifiedAt && <div><dt className="inline">{t('journey.modifiedAt')}：</dt><dd className="inline font-mono">{formatTime(Date.parse(selected.modifiedAt), i18n.language)}</dd></div>}
                      <div><dt className="inline">{t('journey.categoryLabel')}：</dt><dd className="inline font-mono">{selected.category}</dd></div>
                      {selected.source && <div><dt className="inline">{t('journey.source')}：</dt><dd className="inline font-mono break-all">{selected.source}</dd></div>}
                    </dl>
                    {selected.detail && <div className="text-sm text-gray-700 whitespace-pre-wrap break-words max-h-64 overflow-auto">{selected.detail}</div>}
                  </>
                )}
              </Card>
            </div>
          )}
        </>
      )}
    </div>
  );
}
