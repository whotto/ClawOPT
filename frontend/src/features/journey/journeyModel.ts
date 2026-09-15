// 成长轨迹的纯逻辑：分列布局（记忆时间线一列、技能按类别分列、记忆卡片一列）、类别与种类过滤、时间回放的可见集合。
export type JourneyNodeKind = 'memory' | 'daily' | 'skill' | 'card';

export type JourneyNodeView = {
  id: string;
  kind: JourneyNodeKind;
  label: string;
  timestamp: string;
  modifiedAt: string | null;
  category: string;
  detail: string;
  source: string | null;
  createdBy: 'agent' | 'pending' | 'unknown' | 'user' | null;
  state: string | null;
};

export type JourneyEdgeView = { id: string; source: string; target: string; kind: 'sequence' | 'mentions' | 'revision' };

export type JourneyGraphView = {
  agentId: string;
  workspaceAvailable: boolean;
  nodes: JourneyNodeView[];
  edges: JourneyEdgeView[];
  clusters: Array<{ category: string; count: number }>;
  stats: { memory: number; daily: number; skills: number; agentSkills: number; cards: number; first: string | null; last: string | null };
  truncated: boolean;
};

export const JOURNEY_NODE_WIDTH = 200;
export const JOURNEY_COLUMN_GAP = 260;
export const JOURNEY_ROW_GAP = 84;
/** 每列最多几行，超出折到下一列（同一类别连续占列）。 */
export const JOURNEY_MAX_ROWS = 8;

export const KIND_STYLE: Record<JourneyNodeKind, { fill: string; border: string; dot: string }> = {
  memory: { fill: '#eef3fd', border: '#b4c9f4', dot: '#3a6bd4' },
  daily: { fill: '#f7f8fa', border: '#dcdfe5', dot: '#939aa7' },
  skill: { fill: '#e9f4f2', border: '#79b3aa', dot: '#2f8578' },
  card: { fill: '#fbf1e3', border: '#e5c78e', dot: '#a8700f' },
};

export type JourneyFilter = { kinds: Record<JourneyNodeKind, boolean>; category: string | null; query: string };

export const DEFAULT_FILTER: JourneyFilter = { kinds: { memory: true, daily: true, skill: true, card: true }, category: null, query: '' };

export function filterNodes(nodes: JourneyNodeView[], filter: JourneyFilter): JourneyNodeView[] {
  const needle = filter.query.trim().toLowerCase();
  return nodes.filter((node) => {
    if (!filter.kinds[node.kind]) return false;
    if (filter.category && node.category !== filter.category) return false;
    if (needle && !`${node.label}\n${node.detail}\n${node.category}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** 时间回放：前 `step` 个节点（按时间序）可见；step 为 null 表示不在回放，全部可见。 */
export function visibleAtStep(nodes: JourneyNodeView[], step: number | null): Set<string> {
  const sorted = [...nodes].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id.localeCompare(b.id)));
  const count = step === null ? sorted.length : Math.max(0, Math.min(sorted.length, step));
  return new Set(sorted.slice(0, count).map((node) => node.id));
}

/** 只保留两端都在可见集合里的边。 */
export function visibleEdges(edges: JourneyEdgeView[], visible: Set<string>): JourneyEdgeView[] {
  return edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
}

/**
 * 分列布局：第 0 列起是记忆时间线（记忆小节 + 每日记录，按时间），之后技能按类别依次占列，最后是记忆卡片。
 * 每列最多 JOURNEY_MAX_ROWS 行，超出续到右边一列。位置确定性（同一输入同一布局），回放时节点不跳。
 */
export function layoutJourney(nodes: JourneyNodeView[]): Map<string, { x: number; y: number; column: string }> {
  const byTime = (a: JourneyNodeView, b: JourneyNodeView) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id.localeCompare(b.id));
  const groups: Array<{ column: string; items: JourneyNodeView[] }> = [];
  const timeline = nodes.filter((node) => node.kind === 'memory' || node.kind === 'daily').sort(byTime);
  if (timeline.length) groups.push({ column: 'timeline', items: timeline });
  const categories = [...new Set(nodes.filter((node) => node.kind === 'skill').map((node) => node.category))].sort();
  for (const category of categories) groups.push({ column: `skill:${category}`, items: nodes.filter((node) => node.kind === 'skill' && node.category === category).sort(byTime) });
  const cards = nodes.filter((node) => node.kind === 'card').sort(byTime);
  if (cards.length) groups.push({ column: 'cards', items: cards });

  const positions = new Map<string, { x: number; y: number; column: string }>();
  let columnIndex = 0;
  for (const group of groups) {
    group.items.forEach((node, index) => {
      const column = columnIndex + Math.floor(index / JOURNEY_MAX_ROWS);
      positions.set(node.id, { x: column * JOURNEY_COLUMN_GAP, y: (index % JOURNEY_MAX_ROWS) * JOURNEY_ROW_GAP, column: group.column });
    });
    columnIndex += Math.max(1, Math.ceil(group.items.length / JOURNEY_MAX_ROWS));
  }
  return positions;
}

export function neighborsOf(edges: JourneyEdgeView[], id: string | null): Set<string> {
  const out = new Set<string>();
  if (!id) return out;
  out.add(id);
  for (const edge of edges) {
    if (edge.source === id) out.add(edge.target);
    if (edge.target === id) out.add(edge.source);
  }
  return out;
}
