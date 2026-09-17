// 记忆浏览的纯逻辑：卡片形状、作用域标签与配色、图谱布局（按作用域分列、按创建时间排行）、邻居高亮、边过滤。

export type MemoryScope = { type: 'profile'; id: string } | { type: 'context'; namespace: string; id: string } | { type: 'session'; id: string };

export type MemoryCardView = {
  id: string;
  profileId: string;
  scope: MemoryScope;
  kind: string;
  key: string;
  domain: string;
  categoryPath: string;
  type: string;
  revision: number;
  status: 'active' | 'superseded' | 'expired' | 'deleted';
  title: string;
  content: string;
  value: unknown;
  confidence: number;
  importance: number;
  tags: string[];
  entities: string[];
  sourceMessageIds: string[];
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MemoryEdgeKind = 'revision' | 'source' | 'entity';
export type MemoryEdgeView = { id: string; source: string; target: string; kind: MemoryEdgeKind };

/** 可点击的元素只用交互蓝；作用域是身份信息，用中性 / 身份色系的细边与底色区分。 */
export const SCOPE_STYLE: Record<MemoryScope['type'], { border: string; fill: string; dot: string }> = {
  profile: { border: '#79b3aa', fill: '#e9f4f2', dot: '#2f8578' },
  context: { border: '#c2c7d0', fill: '#f7f8fa', dot: '#6e7686' },
  session: { border: '#d8c29a', fill: '#fbf1e3', dot: '#a8700f' },
};

export const EDGE_COLOR: Record<MemoryEdgeKind, string> = {
  revision: '#4c5462',
  source: '#939aa7',
  entity: '#79b3aa',
};

export function scopeLabel(scope: MemoryScope): string {
  return scope.type === 'context' ? `${scope.namespace}:${scope.id}` : `${scope.type}:${scope.id}`;
}

export function scopeKey(scope: MemoryScope): string {
  return scope.type === 'context' ? `context:${scope.namespace}:${scope.id}` : `${scope.type}:${scope.id}`;
}

export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export const NODE_WIDTH = 220;
export const COLUMN_GAP = 60;
export const ROW_HEIGHT = 96;

/** 布局：每个作用域一列（profile 在最左），列内按创建时间从上到下。 */
export function layoutMemoryGraph(cards: MemoryCardView[]): Map<string, { x: number; y: number }> {
  const order: MemoryScope['type'][] = ['profile', 'context', 'session'];
  const columns = [...new Set(cards.map((card) => scopeKey(card.scope)))].sort((a, b) => {
    const typeA = order.indexOf(a.split(':')[0] as MemoryScope['type']);
    const typeB = order.indexOf(b.split(':')[0] as MemoryScope['type']);
    return typeA - typeB || a.localeCompare(b);
  });
  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, columnIndex) => {
    cards
      .filter((card) => scopeKey(card.scope) === column)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)))
      .forEach((card, rowIndex) => positions.set(card.id, { x: columnIndex * (NODE_WIDTH + COLUMN_GAP), y: rowIndex * ROW_HEIGHT }));
  });
  return positions;
}

export function filterEdges(edges: MemoryEdgeView[], enabled: Record<MemoryEdgeKind, boolean>): MemoryEdgeView[] {
  return edges.filter((edge) => enabled[edge.kind]);
}

/** 选中节点的邻居（含自己）；没选中返回 null（不高亮）。 */
export function neighborIds(selected: string | null, edges: MemoryEdgeView[]): Set<string> | null {
  if (!selected) return null;
  const ids = new Set([selected]);
  for (const edge of edges) {
    if (edge.source === selected) ids.add(edge.target);
    if (edge.target === selected) ids.add(edge.source);
  }
  return ids;
}
