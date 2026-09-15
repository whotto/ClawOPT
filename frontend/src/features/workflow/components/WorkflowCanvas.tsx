// React Flow 画布：编辑模式（拖线到空白处建节点、双击边编辑、右键菜单、Ctrl+Z 单级撤销）
// 与回放模式（冻结快照、只读、双击节点看转录、右键重跑）。窄屏（≤768px）只读，可平移缩放。
import '@xyflow/react/dist/base.css';
import './workflow.css';
import {
  Background,
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnConnectEnd,
  type Viewport as FlowViewport,
} from '@xyflow/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CanvasEdge, CanvasNode } from '../hooks/useWorkflowEditor';
import type { AgentRef } from '../lib/types';
import AgentNode from './AgentNode';
import { CanvasContext, type CanvasContextValue } from './canvasContext';
import WorkflowEdgeView from './WorkflowEdgeView';

const nodeTypes = { agent: AgentNode };
const edgeTypes = { workflow: WorkflowEdgeView };

export type ContextMenuAction = { key: string; label: string; disabled?: boolean; danger?: boolean; onSelect: () => void };

type Props = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  context: Omit<CanvasContextValue, 'highlightedEdgeId' | 'onEditEdge'>;
  defaultAgent: AgentRef | null;
  initialViewport: FlowViewport | null;
  onNodesChange?: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange?: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect?: (source: string, target: string, sourceHandle: string | null, targetHandle: string | null) => void;
  onCreateFromHandle?: (agent: AgentRef, position: { x: number; y: number }, from: { nodeId: string; handleId: string | null }) => void;
  onEditEdge: (edgeId: string) => void;
  onViewportChange?: (viewport: FlowViewport) => void;
  onUndo?: () => void;
  nodeMenu: (nodeId: string) => ContextMenuAction[];
  edgeMenu: (edgeId: string) => ContextMenuAction[];
  fitKey: string;
};

function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)');
    const listener = () => setNarrow(media.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);
  return narrow;
}

function CanvasInner(props: Props) {
  const { t } = useTranslation();
  const flow = useReactFlow<CanvasNode, CanvasEdge>();
  const narrow = useNarrowScreen();
  const editable = props.context.mode === 'edit' && !narrow;
  // 只读（回放 / 窄屏）时画布自己持有一份节点：React Flow 量完尺寸要经 onNodesChange 写回，
  // 不写回的话节点一直是 visibility:hidden（回放画布空白就是这个原因）。
  const [readonlyNodes, setReadonlyNodes] = useState<CanvasNode[]>(props.nodes);
  useEffect(() => {
    setReadonlyNodes((previous) => props.nodes.map((node) => {
      const old = previous.find((item) => item.id === node.id);
      return old?.measured ? { ...node, measured: old.measured } : node;
    }));
  }, [props.nodes]);
  const onReadonlyNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    setReadonlyNodes((current) => applyNodeChanges(changes.filter((change) => change.type === 'dimensions' || change.type === 'select'), current));
  };
  const [highlightedEdgeId, setHighlightedEdgeId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; actions: ContextMenuAction[] } | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  // 只在切换工作流 / 运行快照时重置视口，并且要等节点量完尺寸——
  // 快照换进来的新节点还没测量时 fitView 算出来的视口是空白的。
  const nodesInitialized = useNodesInitialized();
  const fittedKey = useRef<string | null>(null);
  useEffect(() => {
    if (fittedKey.current === props.fitKey) return;
    if (!nodesInitialized && props.nodes.length) return;
    fittedKey.current = props.fitKey;
    if (props.initialViewport) void flow.setViewport(props.initialViewport);
    else void flow.fitView({ padding: 0.2, maxZoom: 1 });
  }, [props.fitKey, nodesInitialized, props.nodes.length, props.initialViewport, flow]);

  useEffect(() => {
    if (!props.onUndo || props.context.mode !== 'edit') return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      event.preventDefault();
      props.onUndo?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onUndo, props.context.mode]);

  const contextValue = useMemo<CanvasContextValue>(() => ({
    ...props.context,
    mode: editable ? 'edit' : props.context.mode === 'edit' ? 'readonly' : props.context.mode,
    highlightedEdgeId,
    onEditEdge: (edgeId) => (editable ? props.onEditEdge(edgeId) : undefined),
  }), [props.context, editable, highlightedEdgeId, props.onEditEdge]);

  const onConnectEnd: OnConnectEnd = (event, state) => {
    if (!editable || state.isValid || !state.fromNode || !props.onCreateFromHandle || !props.defaultAgent) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    const position = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    props.onCreateFromHandle(props.defaultAgent, { x: position.x - 130, y: position.y - 20 }, { nodeId: state.fromNode.id, handleId: state.fromHandle?.id ?? null });
  };

  const openMenu = (event: React.MouseEvent, actions: ContextMenuAction[]) => {
    event.preventDefault();
    if (!actions.length) return;
    const rect = wrapper.current?.getBoundingClientRect();
    setMenu({ x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0), actions });
  };

  return (
    <CanvasContext.Provider value={contextValue}>
      <div ref={wrapper} className="workflow-canvas relative w-full h-full bg-gray-50" onClick={() => setMenu(null)}>
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={editable ? props.nodes : readonlyNodes}
          edges={props.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          connectionMode={ConnectionMode.Loose}
          onNodesChange={editable ? props.onNodesChange : onReadonlyNodesChange}
          onEdgesChange={editable ? props.onEdgesChange : undefined}
          onConnect={editable ? (connection: Connection) => props.onConnect?.(connection.source, connection.target, connection.sourceHandle ?? null, connection.targetHandle ?? null) : undefined}
          onConnectEnd={onConnectEnd}
          isValidConnection={(connection) => !(connection.source === connection.target && connection.sourceHandle === connection.targetHandle)}
          nodesDraggable={editable}
          nodesConnectable={editable}
          elementsSelectable
          deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
          onEdgeClick={(_event, edge) => {
            setHighlightedEdgeId(edge.id);
            if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
            highlightTimer.current = window.setTimeout(() => setHighlightedEdgeId(null), 1800);
          }}
          onEdgeDoubleClick={(_event, edge) => (editable ? props.onEditEdge(edge.id) : undefined)}
          onNodeContextMenu={(event, node) => openMenu(event, props.nodeMenu(node.id))}
          onEdgeContextMenu={(event, edge) => openMenu(event, editable ? props.edgeMenu(edge.id) : [])}
          onMoveEnd={(_event, viewport) => props.onViewportChange?.(viewport)}
          zoomOnDoubleClick={false}
          minZoom={0.2}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="var(--color-gray-200)" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        {narrow && props.context.mode === 'edit' && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 text-xs rounded-lg border border-gray-200 bg-white text-gray-500">
            {t('automation.canvas.mobileReadonly')}
          </div>
        )}
        {menu && (
          <div className="absolute z-20 min-w-[180px] py-1 rounded-xl border border-gray-200 bg-white" style={{ left: menu.x, top: menu.y }}>
            {menu.actions.map((action) => (
              <button
                key={action.key}
                disabled={action.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu(null);
                  action.onSelect();
                }}
                className={`block w-full text-left px-3 py-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 ${action.danger ? 'text-red-600' : 'text-gray-700'}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </CanvasContext.Provider>
  );
}

export default function WorkflowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
