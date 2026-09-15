// 任务计划卡的数据与纯逻辑（带单测）：按 revision 合并（旧的不覆盖新的）、完成计数、结局横幅。

export type PlanStep = { text: string; status: 'pending' | 'in_progress' | 'completed' };
export type TaskPlan = {
  messageId: number;
  runMarker: string;
  revision: number;
  executionState: 'running' | 'completed' | 'failed' | 'interrupted';
  steps: PlanStep[];
};

export function normalizeTaskPlan(raw: any): TaskPlan | null {
  if (!raw || typeof raw.messageId !== 'number' || typeof raw.revision !== 'number' || !Array.isArray(raw.steps)) return null;
  const state = ['running', 'completed', 'failed', 'interrupted'].includes(raw.executionState) ? raw.executionState : 'running';
  return {
    messageId: raw.messageId,
    runMarker: String(raw.runMarker ?? ''),
    revision: raw.revision,
    executionState: state,
    steps: raw.steps
      .filter((step: any) => typeof step?.text === 'string')
      .map((step: any) => ({ text: step.text, status: step.status === 'completed' || step.status === 'in_progress' ? step.status : 'pending' })),
  };
}

/** 同一条消息同一轮：只收 revision 更大的（接口快照与实时帧先到后到都可能）。 */
export function mergeTaskPlans(current: Record<string, TaskPlan>, incoming: ReadonlyArray<TaskPlan>): Record<string, TaskPlan> {
  let next = current;
  for (const plan of incoming) {
    const key = `${plan.messageId}:${plan.runMarker}`;
    const existing = next[key];
    if (existing && existing.revision >= plan.revision) continue;
    if (next === current) next = { ...current };
    next[key] = plan;
  }
  return next;
}

export function plansByMessage(plans: Record<string, TaskPlan>): Map<string, TaskPlan[]> {
  const map = new Map<string, TaskPlan[]>();
  for (const plan of Object.values(plans)) {
    const key = String(plan.messageId);
    map.set(key, [...(map.get(key) ?? []), plan]);
  }
  return map;
}

export function planProgress(plan: Pick<TaskPlan, 'steps' | 'executionState'>): { completed: number; total: number; banner: 'running' | 'unfinished' | 'interrupted' | 'failed' | null } {
  const completed = plan.steps.filter((step) => step.status === 'completed').length;
  const total = plan.steps.length;
  let banner: 'running' | 'unfinished' | 'interrupted' | 'failed' | null = null;
  if (plan.executionState === 'running') banner = 'running';
  else if (plan.executionState === 'interrupted') banner = 'interrupted';
  else if (plan.executionState === 'failed') banner = 'failed';
  else if (completed < total) banner = 'unfinished';
  return { completed, total, banner };
}
