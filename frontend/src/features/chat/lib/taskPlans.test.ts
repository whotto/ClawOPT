import { describe, expect, it } from 'vitest';
import { mergeTaskPlans, normalizeTaskPlan, planProgress, plansByMessage } from './taskPlans';

const plan = (revision: number, over: Record<string, unknown> = {}) => normalizeTaskPlan({ messageId: 7, runMarker: 'r', revision, executionState: 'running', steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }], ...over })!;

describe('taskPlans', () => {
  it('按 revision 合并：晚到的旧快照不覆盖新的', () => {
    const merged = mergeTaskPlans(mergeTaskPlans({}, [plan(3)]), [plan(2, { executionState: 'completed' })]);
    expect(Object.values(merged)[0]).toMatchObject({ revision: 3, executionState: 'running' });
    expect(Object.values(mergeTaskPlans(merged, [plan(4, { executionState: 'interrupted' })]))[0].executionState).toBe('interrupted');
    expect(plansByMessage(merged).get('7')).toHaveLength(1);
  });

  it('进度与横幅：运行中 / 结束但有未完成 / 中断 / 失败', () => {
    expect(planProgress(plan(1))).toEqual({ completed: 1, total: 2, banner: 'running' });
    expect(planProgress(plan(1, { executionState: 'completed' })).banner).toBe('unfinished');
    expect(planProgress(plan(1, { executionState: 'completed', steps: [{ text: 'a', status: 'completed' }] })).banner).toBeNull();
    expect(planProgress(plan(1, { executionState: 'interrupted' })).banner).toBe('interrupted');
  });

  it('形状不对的快照忽略', () => {
    expect(normalizeTaskPlan({ messageId: '7' })).toBeNull();
  });
});
