/**
 * 单聊的任务计划卡（P1b）。
 *
 * ## 计划从哪来（按运行时实际发出的东西映射，不猜）
 *
 * - ACP 运行时（DSH、Hermes）与 Grok：契约事件 `plan.updated`，负载 `{ entries }`——条目可以是字符串，也可以是
 *   `{ content, status }`（ACP 原生形状，status: pending / in_progress / completed）；
 * - Claude Code：没有计划事件，计划是 `TodoWrite` 工具调用的参数 `{ todos: [{ content, status, activeForm }] }`；
 * - Codex：`update_plan` 工具调用的参数 `{ plan: [{ step, status }], explanation? }`；
 * - OpenClaw 网关与其余运行时：今天不发计划，不显示卡片。
 *
 * ## 存与发
 *
 * - 每轮一行（会话 + run marker），**每次更新 revision + 1**，存最新快照（`task_plans`）；
 * - 实时帧 `task.plan.updated`（会话实时通道转发）带整份快照，前端按 revision 取新的；
 * - **终态重发**：运行结束时把快照带上执行结局（completed / failed / interrupted）再发一次，还在 in_progress 的步骤
 *   退回 pending（运行已经停了，界面上不能留一个永远转着的步骤）。
 *
 * 实现是投影器的包装（`withTaskPlans`）：不改各表面投影器的正文与落库逻辑。
 */
import type Database from 'better-sqlite3';

import type { AdapterRunOutcome, CanonicalEvent, ProjectorFinish, ProjectorRunContext, RunProjector } from '../../runtime';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';
export type PlanExecutionState = 'running' | 'completed' | 'failed' | 'interrupted';
export type PlanStep = { text: string; status: PlanStepStatus };
export type TaskPlanSnapshot = {
  messageId: number;
  runMarker: string;
  revision: number;
  executionState: PlanExecutionState;
  steps: PlanStep[];
  updatedAt: number;
};

export const TASK_PLAN_EVENT = 'task.plan.updated';
const MAX_STEPS = 50;
const MAX_STEP_CHARS = 500;

function normalizeStatus(raw: unknown): PlanStepStatus {
  const value = String(raw ?? '').toLowerCase();
  if (value === 'completed' || value === 'done' || value === 'complete') return 'completed';
  if (value === 'in_progress' || value === 'in-progress' || value === 'running' || value === 'active') return 'in_progress';
  return 'pending';
}

function toSteps(entries: unknown[], textKeys: string[]): PlanStep[] {
  return entries.slice(0, MAX_STEPS).flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() ? [{ text: entry.trim().slice(0, MAX_STEP_CHARS), status: 'pending' as const }] : [];
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const text = textKeys.map((key) => record[key]).find((value) => typeof value === 'string' && value.trim()) as string | undefined;
    return text ? [{ text: text.trim().slice(0, MAX_STEP_CHARS), status: normalizeStatus(record.status) }] : [];
  });
}

/** 契约事件 `plan.updated` 的负载 → 步骤。认不出返回 null（不显示，不编）。 */
export function stepsFromPlanEvent(plan: unknown): PlanStep[] | null {
  const entries = Array.isArray(plan) ? plan : Array.isArray((plan as { entries?: unknown })?.entries) ? (plan as { entries: unknown[] }).entries : null;
  if (!entries) return null;
  const steps = toSteps(entries, ['content', 'title', 'step', 'text']);
  return steps.length > 0 ? steps : null;
}

/** 工具调用里的计划（Claude Code `TodoWrite`、Codex `update_plan`）→ 步骤；不是计划工具返回 null。 */
export function stepsFromPlanTool(name: string, rawArguments: string | undefined): PlanStep[] | null {
  const normalized = name.toLowerCase();
  if (normalized !== 'todowrite' && normalized !== 'update_plan') return null;
  let args: any;
  try {
    args = rawArguments ? JSON.parse(rawArguments) : null;
  } catch {
    return null;
  }
  const entries = normalized === 'todowrite' ? args?.todos : args?.plan;
  if (!Array.isArray(entries)) return null;
  const steps = toSteps(entries, normalized === 'todowrite' ? ['content', 'activeForm'] : ['step', 'content']);
  return steps.length > 0 ? steps : null;
}

/** 终态重发：写上结局，没完成的 in_progress 退回 pending。 */
export function finalizePlanSteps(steps: PlanStep[], outcome: AdapterRunOutcome): { steps: PlanStep[]; executionState: PlanExecutionState } {
  const executionState: PlanExecutionState = outcome.kind === 'completed' ? 'completed' : outcome.kind === 'failed' ? 'failed' : 'interrupted';
  return { executionState, steps: steps.map((step) => (step.status === 'in_progress' ? { ...step, status: 'pending' } : step)) };
}

export class TaskPlanStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_plans (
        session_key TEXT NOT NULL,
        run_marker TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        execution_state TEXT NOT NULL,
        steps TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_key, run_marker)
      );
      CREATE INDEX IF NOT EXISTS idx_task_plans_message ON task_plans(session_key, message_id);
    `);
  }

  /** 写一次更新：revision 在库里 + 1（同一轮的并发更新不会拿同一个 revision）。 */
  save(sessionKey: string, input: { runMarker: string; messageId: number; executionState: PlanExecutionState; steps: PlanStep[] }, now = Date.now()): TaskPlanSnapshot {
    const row = this.db.prepare(`
      INSERT INTO task_plans (session_key, run_marker, message_id, revision, execution_state, steps, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(session_key, run_marker) DO UPDATE SET revision = revision + 1, message_id = excluded.message_id,
        execution_state = excluded.execution_state, steps = excluded.steps, updated_at = excluded.updated_at
      RETURNING revision
    `).get(sessionKey, input.runMarker, input.messageId, input.executionState, JSON.stringify(input.steps), now) as { revision: number };
    return { messageId: input.messageId, runMarker: input.runMarker, revision: row.revision, executionState: input.executionState, steps: input.steps, updatedAt: now };
  }

  listForMessages(sessionKey: string, messageIds: number[]): TaskPlanSnapshot[] {
    if (messageIds.length === 0) return [];
    const rows = this.db.prepare(`SELECT run_marker, message_id, revision, execution_state, steps, updated_at FROM task_plans WHERE session_key = ? AND message_id IN (${messageIds.map(() => '?').join(',')})`)
      .all(sessionKey, ...messageIds) as Array<{ run_marker: string; message_id: number; revision: number; execution_state: PlanExecutionState; steps: string; updated_at: number }>;
    return rows.map((row) => {
      let steps: PlanStep[] = [];
      try { steps = JSON.parse(row.steps); } catch {}
      return { messageId: row.message_id, runMarker: row.run_marker, revision: row.revision, executionState: row.execution_state, steps, updatedAt: row.updated_at };
    });
  }

  deleteBySession(sessionKey: string): void {
    this.db.prepare('DELETE FROM task_plans WHERE session_key = ?').run(sessionKey);
  }
}

/**
 * 给表面投影器加上计划跟踪。消息 id 在投影器建起来时读（排队的一轮出队时才有）。
 * 帧经协调器发到会话主题（重放按键替换：接回的人只要最新的那份）。
 */
export function withTaskPlans(
  store: TaskPlanStore,
  run: ProjectorRunContext,
  messageId: () => number,
  inner: RunProjector,
): RunProjector {
  let steps: PlanStep[] | null = null;
  const publish = (executionState: PlanExecutionState) => {
    if (!steps) return;
    const snapshot = store.save(run.sessionKey, { runMarker: run.runMarker, messageId: messageId(), executionState, steps });
    run.publish(TASK_PLAN_EVENT, snapshot, { replay: { mode: 'replace', key: TASK_PLAN_EVENT } });
  };
  return {
    onEvent(event: CanonicalEvent) {
      inner.onEvent(event);
      try {
        let next: PlanStep[] | null = null;
        if (event.type === 'plan.updated') next = stepsFromPlanEvent(event.plan);
        else if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item.type === 'function_call') next = stepsFromPlanTool(event.item.name, event.item.arguments);
        else if (event.type === 'response.function_call.updated') next = stepsFromPlanTool(event.name, event.arguments);
        if (next) {
          steps = next;
          publish('running');
        }
      } catch (error) {
        console.warn(`[chat] task plan tracking failed for ${run.sessionKey}:`, (error as Error)?.message);
      }
    },
    finish(outcome: AdapterRunOutcome): ProjectorFinish {
      const result = inner.finish(outcome);
      if (steps) {
        try {
          const finalized = finalizePlanSteps(steps, outcome);
          steps = finalized.steps;
          publish(finalized.executionState);
        } catch (error) {
          console.warn(`[chat] task plan finalize failed for ${run.sessionKey}:`, (error as Error)?.message);
        }
      }
      return result;
    },
    attachSnapshot: inner.attachSnapshot ? () => inner.attachSnapshot!() : undefined,
  };
}
