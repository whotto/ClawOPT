import { useCallback, useEffect, useRef, useState } from 'react';
import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import { getWorkflow, updateWorkflow } from '../../../api/automation';
import { defaultNodeData, makeEdge, nextNodeId, toSavePayload, validateForSave, type GraphIssue } from '../lib/graph';
import { requestJson, type ApiError } from '../lib/request';
import type { AgentRef, EdgeOrchestration, Viewport, WfEdge, WfNode, WorkflowDefinition, WorkflowNodeData } from '../lib/types';

export type CanvasNode = Node<WorkflowNodeData, 'agent'>;
export type CanvasEdge = Edge<{ orchestration: EdgeOrchestration }, 'workflow'>;

export const toCanvasNode = (node: WfNode): CanvasNode => ({ id: node.id, type: 'agent', position: node.position, data: node.data });
export const toCanvasEdge = (edge: WfEdge): CanvasEdge => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  sourceHandle: edge.sourceHandle ?? undefined,
  targetHandle: edge.targetHandle ?? undefined,
  type: 'workflow',
  data: { orchestration: edge.data.orchestration },
});
export const fromCanvasNode = (node: CanvasNode): WfNode => ({ id: node.id, type: 'agent', position: node.position, data: node.data });
export const fromCanvasEdge = (edge: CanvasEdge): WfEdge => ({
  id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle ?? null, targetHandle: edge.targetHandle ?? null,
  data: { orchestration: edge.data?.orchestration ?? { route: 'success' } },
});

type Snapshot = { nodes: CanvasNode[]; edges: CanvasEdge[] };

/**
 * 画布编辑状态：定义加载、节点与边、脏标记、单级撤销、保存（先跑与服务端同判据的校验）。
 * 撤销只记「结构性」操作（加 / 删节点、连线、拖线建节点），拖动位置不进撤销栈。
 */
export function useWorkflowEditor(workflowId: string | null, onSaved: () => void) {
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState('');
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [edges, setEdges] = useState<CanvasEdge[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issue, setIssue] = useState<GraphIssue | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const undoRef = useRef<Snapshot | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const viewportRef = useRef<Viewport | null>(null);
  const loadToken = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    if (!workflowId) {
      setDefinition(null);
      setNodes([]);
      setEdges([]);
      return;
    }
    const result = await requestJson<{ workflow: WorkflowDefinition }>(getWorkflow(workflowId));
    if (token !== loadToken.current) return; // 切换工作流时丢弃过期响应
    if (!result.ok) {
      setError(result.error);
      setDefinition(null);
      return;
    }
    const def = result.data.workflow;
    setDefinition(def);
    setName(def.name);
    setNodes(def.nodes.map(toCanvasNode));
    setEdges(def.edges.map(toCanvasEdge));
    viewportRef.current = def.viewport;
    setDirty(false);
    setIssue(null);
    undoRef.current = null;
    setCanUndo(false);
  }, [workflowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const checkpoint = useCallback(() => {
    undoRef.current = { nodes, edges };
    setCanUndo(true);
  }, [nodes, edges]);

  const undo = useCallback(() => {
    if (!undoRef.current) return;
    setNodes(undoRef.current.nodes);
    setEdges(undoRef.current.edges);
    undoRef.current = null;
    setCanUndo(false);
    setDirty(true);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    const removing = changes.some((change) => change.type === 'remove');
    if (removing) checkpoint();
    setNodes((current) => applyNodeChanges(changes, current));
    if (changes.some((change) => change.type === 'position' || change.type === 'remove' || change.type === 'dimensions' && change.resizing)) setDirty(true);
  }, [checkpoint]);

  const onEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    if (changes.some((change) => change.type === 'remove')) {
      checkpoint();
      setDirty(true);
    }
    setEdges((current) => applyEdgeChanges(changes, current));
  }, [checkpoint]);

  const updateNodeData = useCallback((nodeId: string, patch: Partial<WorkflowNodeData>) => {
    setNodes((current) => current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)));
    setDirty(true);
  }, []);

  const addNode = useCallback((agent: AgentRef, position: { x: number; y: number }, from?: { nodeId: string; handleId: string | null }) => {
    checkpoint();
    const id = nextNodeId(nodes.map(fromCanvasNode));
    const node: CanvasNode = { id, type: 'agent', position, data: defaultNodeData(agent, id), selected: true };
    setNodes((current) => [...current.map((item) => ({ ...item, selected: false })), node]);
    if (from) {
      const created = makeEdge(edges.map(fromCanvasEdge), from.nodeId, id, from.handleId, null);
      setEdges((current) => [...current, toCanvasEdge(created)]);
    }
    setDirty(true);
    return id;
  }, [checkpoint, nodes, edges]);

  const connect = useCallback((source: string, target: string, sourceHandle: string | null, targetHandle: string | null) => {
    if (source === target && sourceHandle && sourceHandle === targetHandle) return;
    checkpoint();
    setEdges((current) => [...current, toCanvasEdge(makeEdge(current.map(fromCanvasEdge), source, target, sourceHandle, targetHandle))]);
    setDirty(true);
  }, [checkpoint]);

  const updateEdge = useCallback((edgeId: string, orchestration: EdgeOrchestration) => {
    setEdges((current) => current.map((edge) => (edge.id === edgeId ? { ...edge, data: { orchestration } } : edge)));
    setDirty(true);
  }, []);

  const removeElements = useCallback((nodeIds: string[], edgeIds: string[]) => {
    checkpoint();
    setNodes((current) => current.filter((node) => !nodeIds.includes(node.id)));
    setEdges((current) => current.filter((edge) => !edgeIds.includes(edge.id) && !nodeIds.includes(edge.source) && !nodeIds.includes(edge.target)));
    setDirty(true);
  }, [checkpoint]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!workflowId) return false;
    const wfNodes = nodes.map(fromCanvasNode);
    const wfEdges = edges.map(fromCanvasEdge);
    const found = validateForSave(wfNodes, wfEdges);
    setIssue(found);
    if (found) return false;
    setSaving(true);
    const result = await requestJson<{ workflow: WorkflowDefinition }>(updateWorkflow(workflowId, {
      name: name.trim(),
      ...toSavePayload(wfNodes, wfEdges),
      viewport: viewportRef.current,
    }));
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setDefinition(result.data.workflow);
    setDirty(false);
    setError(null);
    setSavedAt(Date.now());
    onSaved();
    return true;
  }, [workflowId, nodes, edges, name, onSaved]);

  return {
    definition, name, setName: (value: string) => { setName(value); setDirty(true); },
    nodes, edges, dirty, saving, issue, setIssue, error, setError, savedAt, canUndo,
    onNodesChange, onEdgesChange, updateNodeData, addNode, connect, updateEdge, removeElements, undo, save, reload: load,
    setViewport: (viewport: Viewport) => { viewportRef.current = viewport; },
    initialViewport: () => viewportRef.current,
  };
}

export type WorkflowEditorController = ReturnType<typeof useWorkflowEditor>;
