import { createContext, useContext } from 'react';
import type { AgentEntry, NodeStatus, WorkflowNodeData } from '../lib/types';

export type CanvasMode = 'edit' | 'replay' | 'readonly';

export type CanvasContextValue = {
  mode: CanvasMode;
  agents: AgentEntry[];
  statusOf: (nodeId: string) => NodeStatus | null;
  errorOf: (nodeId: string) => string | null;
  onChange: (nodeId: string, patch: Partial<WorkflowNodeData>) => void;
  onOpenNode: (nodeId: string) => void;
  highlightedEdgeId: string | null;
  edgeStateOf: (edgeId: string) => string | null;
  onEditEdge: (edgeId: string) => void;
};

export const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvasContext(): CanvasContextValue {
  const value = useContext(CanvasContext);
  if (!value) throw new Error('CanvasContext missing');
  return value;
}

export const agentKey = (agent: { kind: string; id: string }) => `${agent.kind}:${agent.id}`;
