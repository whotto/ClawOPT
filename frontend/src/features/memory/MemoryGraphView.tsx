// 记忆图谱：节点按作用域上色（图例），三种边（版本链 / 同源 / 同实体）可开关；点选高亮邻居。只读画布，编辑在详情面板里。
import '@xyflow/react/dist/base.css';
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EDGE_COLOR, filterEdges, layoutMemoryGraph, neighborIds, NODE_WIDTH, SCOPE_STYLE, type MemoryCardView, type MemoryEdgeKind, type MemoryEdgeView } from './memoryModel';

type MemoryNodeData = { card: MemoryCardView; dimmed: boolean; selected: boolean };

function MemoryNode({ data }: NodeProps<Node<MemoryNodeData>>) {
  const { card, dimmed, selected } = data;
  const style = SCOPE_STYLE[card.scope.type];
  return (
    <div
      className={`rounded-xl border px-3 py-2 text-left transition-opacity ${dimmed ? 'opacity-30' : 'opacity-100'} ${card.status !== 'active' ? 'border-dashed' : ''}`}
      style={{ width: NODE_WIDTH, background: style.fill, borderColor: selected ? '#2a55b8' : style.border, borderWidth: selected ? 2 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="!w-1 !h-1 !min-w-0 !border-0 !bg-transparent" />
      <div className="text-xs font-semibold text-gray-900 truncate">{card.title}</div>
      <div className="mt-0.5 text-[11px] font-mono text-gray-500 truncate">{card.key}</div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-gray-500">
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: style.dot }} />
        <span>r{card.revision}</span>
        <span className="truncate">{card.status}</span>
      </div>
      <Handle type="source" position={Position.Right} className="!w-1 !h-1 !min-w-0 !border-0 !bg-transparent" />
    </div>
  );
}

const nodeTypes = { memory: MemoryNode };

export function MemoryGraphView({ cards, edges, enabledEdges, onToggleEdge, selectedId, onSelect }: {
  cards: MemoryCardView[];
  edges: MemoryEdgeView[];
  enabledEdges: Record<MemoryEdgeKind, boolean>;
  onToggleEdge: (kind: MemoryEdgeKind) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const visibleEdges = useMemo(() => filterEdges(edges, enabledEdges), [edges, enabledEdges]);
  const highlight = useMemo(() => neighborIds(selectedId, visibleEdges), [selectedId, visibleEdges]);
  const nodes = useMemo<Node<MemoryNodeData>[]>(() => {
    const positions = layoutMemoryGraph(cards);
    return cards.map((card) => ({
      id: card.id,
      type: 'memory',
      position: positions.get(card.id) ?? { x: 0, y: 0 },
      data: { card, dimmed: highlight !== null && !highlight.has(card.id), selected: card.id === selectedId },
      draggable: false,
    }));
  }, [cards, highlight, selectedId]);
  const flowEdges = useMemo<Edge[]>(() => visibleEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: edge.kind === 'revision' && highlight !== null && highlight.has(edge.source) && highlight.has(edge.target),
    style: {
      stroke: EDGE_COLOR[edge.kind],
      strokeWidth: edge.kind === 'revision' ? 1.5 : 1,
      strokeDasharray: edge.kind === 'entity' ? '4 3' : edge.kind === 'source' ? '1 3' : undefined,
      opacity: highlight !== null && !(highlight.has(edge.source) && highlight.has(edge.target)) ? 0.15 : 1,
    },
  })), [visibleEdges, highlight]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <span className="font-medium text-gray-700">{t('memoryService.page.legendScope')}</span>
        {(['profile', 'context', 'session'] as const).map((type) => (
          <span key={type} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded border" style={{ background: SCOPE_STYLE[type].fill, borderColor: SCOPE_STYLE[type].border }} />
            {t(`memoryService.page.scope.${type}`)}
          </span>
        ))}
        <span className="font-medium text-gray-700 sm:ml-4">{t('memoryService.page.legendEdges')}</span>
        {(['revision', 'source', 'entity'] as const).map((kind) => (
          <label key={kind} className="inline-flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={enabledEdges[kind]} onChange={() => onToggleEdge(kind)} className="rounded border-gray-300" />
            <span className="inline-block w-4 border-t-2" style={{ borderColor: EDGE_COLOR[kind], borderStyle: kind === 'revision' ? 'solid' : 'dashed' }} />
            {t(`memoryService.page.edge.${kind}`)}
          </label>
        ))}
      </div>
      <div className="h-[60vh] min-h-[320px] rounded-2xl border border-gray-200 bg-white overflow-hidden" data-testid="memory-graph">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.2}
            nodesConnectable={false}
            nodesDraggable={false}
            onNodeClick={(_event, node) => onSelect(node.id === selectedId ? null : node.id)}
            onPaneClick={() => onSelect(null)}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1} color="#dcdfe5" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}
