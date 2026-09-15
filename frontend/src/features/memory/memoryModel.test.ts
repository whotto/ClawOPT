import { describe, expect, it } from 'vitest';
import { filterEdges, layoutMemoryGraph, neighborIds, scopeLabel, type MemoryCardView, type MemoryEdgeView } from './memoryModel';

const card = (id: string, scope: MemoryCardView['scope'], createdAt: string): MemoryCardView => ({
  id, profileId: 'main', scope, kind: 'habit', key: `habit:${id}`, domain: 'lifestyle', categoryPath: 'lifestyle/habit', type: 'fact',
  revision: 1, status: 'active', title: id, content: id, value: null, confidence: 0.9, importance: 0.6, tags: [], entities: [], sourceMessageIds: [],
  supersedesId: null, createdAt, updatedAt: createdAt,
});

describe('记忆图谱纯逻辑', () => {
  it('按作用域分列（profile 在最左），列内按创建时间排', () => {
    const positions = layoutMemoryGraph([
      card('c2', { type: 'context', namespace: 'group-chat', id: 'g1' }, '2026-01-02'),
      card('p2', { type: 'profile', id: 'main' }, '2026-01-03'),
      card('p1', { type: 'profile', id: 'main' }, '2026-01-01'),
    ]);
    expect(positions.get('p1')).toEqual({ x: 0, y: 0 });
    expect(positions.get('p2')!.y).toBeGreaterThan(0);
    expect(positions.get('c2')!.x).toBeGreaterThan(0);
  });

  it('边按种类开关过滤；邻居高亮含自己', () => {
    const edges: MemoryEdgeView[] = [
      { id: 'r', source: 'a', target: 'b', kind: 'revision' },
      { id: 's', source: 'b', target: 'c', kind: 'source' },
    ];
    expect(filterEdges(edges, { revision: true, source: false, entity: true }).map((edge) => edge.id)).toEqual(['r']);
    expect([...neighborIds('b', edges)!].sort()).toEqual(['a', 'b', 'c']);
    expect(neighborIds(null, edges)).toBeNull();
    expect(scopeLabel({ type: 'context', namespace: 'group-chat', id: 'g1' })).toBe('group-chat:g1');
  });
});
