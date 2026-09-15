import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER, JOURNEY_MAX_ROWS, filterNodes, layoutJourney, neighborsOf, visibleAtStep, visibleEdges, type JourneyNodeView } from './journeyModel';

const node = (id: string, kind: JourneyNodeView['kind'], timestamp: string, category = kind as string): JourneyNodeView => ({
  id, kind, label: id, timestamp, modifiedAt: null, category, detail: '', source: null, createdBy: null, state: null,
});

describe('成长轨迹模型', () => {
  const nodes = [
    node('m2', 'memory', '2026-09-10'),
    node('m1', 'memory', '2026-09-01'),
    node('s1', 'skill', '2026-09-05', 'writing'),
    node('s2', 'skill', '2026-09-06', 'code'),
    node('c1', 'card', '2026-09-02', 'profile'),
  ];

  it('时间回放按时间序逐个出现，边两端都可见才画', () => {
    const step2 = visibleAtStep(nodes, 2);
    expect([...step2].sort()).toEqual(['c1', 'm1']);
    expect(visibleAtStep(nodes, null).size).toBe(5);
    expect(visibleEdges([{ id: 'e', source: 'm1', target: 's1', kind: 'mentions' }], step2)).toEqual([]);
  });

  it('按种类、类别与关键字过滤', () => {
    expect(filterNodes(nodes, { ...DEFAULT_FILTER, kinds: { ...DEFAULT_FILTER.kinds, memory: false } }).map((item) => item.id)).toEqual(['s1', 's2', 'c1']);
    expect(filterNodes(nodes, { ...DEFAULT_FILTER, category: 'writing' }).map((item) => item.id)).toEqual(['s1']);
    expect(filterNodes(nodes, { ...DEFAULT_FILTER, query: 'C1' }).map((item) => item.id)).toEqual(['c1']);
  });

  it('分列布局：时间线一列、技能按类别各一列、卡片一列；超出行数续列；确定性', () => {
    const layout = layoutJourney(nodes);
    expect(layout.get('m1')).toEqual({ x: 0, y: 0, column: 'timeline' });
    expect(layout.get('m2')?.y).toBeGreaterThan(0);
    expect(layout.get('s2')?.column).toBe('skill:code');
    expect(layout.get('s1')!.x).toBeGreaterThan(layout.get('s2')!.x);
    expect(layout.get('c1')!.x).toBeGreaterThan(layout.get('s1')!.x);
    const many = Array.from({ length: JOURNEY_MAX_ROWS + 1 }, (_, index) => node(`d${index}`, 'daily', `2026-01-${String(index + 1).padStart(2, '0')}`));
    const wrapped = layoutJourney(many);
    expect(wrapped.get(`d${JOURNEY_MAX_ROWS}`)).toEqual({ x: wrapped.get('d0')!.x + 260, y: 0, column: 'timeline' });
    expect(layoutJourney(nodes)).toEqual(layout);
  });

  it('邻居高亮', () => {
    expect([...neighborsOf([{ id: 'e', source: 'm1', target: 's1', kind: 'mentions' }], 's1')].sort()).toEqual(['m1', 's1']);
    expect(neighborsOf([], null).size).toBe(0);
  });
});
