/**
 * 原生看板（对方是 Hermes CLI 的代理；ClawOPT 自己存状态、自己派活）。
 *
 * - 状态迁移守卫在服务端：读当前状态 → 判能不能迁 → 条件更新（状态没被并发改过才生效），不行就 409 + messageCode；
 * - 「派活」把任务的负责 Agent 经 `WorkflowAgentRunner` 跑一轮，结果写回任务（成功进 review，失败进 blocked）并留一条运行记录；
 * - 人工完成是覆盖操作：正在跑的派活先落库 canceled，再中止；
 * - 批量操作 ≤100，逐条执行、逐条回报。
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { AutomationError, KANBAN_ERROR, notFound } from '../shared/errors';
import { clampInt, isPlainObject, uniqueStrings } from '../shared/util';
import type { AgentDirectory, WorkflowAgentRef, WorkflowAgentRunner } from '../ports';
import { DEFAULT_BOARD_ID, KANBAN_STATUSES, type KanbanStatus, type KanbanStore, type TaskRecord } from './kanban-store';

export const MAX_BULK = 100;
export const DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

/** 普通「移动」允许的迁移。running 只能由派活进入；done 只能由 complete 进入。 */
export const MOVE_TRANSITIONS: Record<KanbanStatus, KanbanStatus[]> = {
  triage: ['todo', 'ready', 'archived'],
  todo: ['triage', 'scheduled', 'ready', 'archived'],
  scheduled: ['todo', 'ready', 'archived'],
  ready: ['todo', 'scheduled', 'archived'],
  running: [],
  blocked: ['todo', 'archived'],
  review: ['ready', 'archived'],
  done: ['ready', 'archived'],
  archived: ['todo'],
};

export const ACTION_FROM = {
  complete: ['running', 'ready', 'blocked', 'review'],
  block: ['running', 'ready', 'todo', 'review'],
  unblock: ['blocked', 'scheduled'],
  reclaim: ['running'],
  dispatch: ['ready'],
  archive: ['triage', 'todo', 'scheduled', 'ready', 'blocked', 'review', 'done'],
} as const;

const invalid = (field: string) => new AutomationError(400, KANBAN_ERROR.invalidBody, field, { field });
const badTransition = (from: string, action: string) => new AutomationError(409, KANBAN_ERROR.invalidTransition, `${action} not allowed from ${from}`, { from, action });

export function createKanbanService(deps: {
  store: KanbanStore;
  runner: WorkflowAgentRunner;
  directory: AgentDirectory;
  defaultWorkspace: (taskId: string) => string;
}) {
  const { store, runner } = deps;
  const controllers = new Map<string, { runId: string; sessionId: string; controller: AbortController; done: Promise<void> }>();

  function requireTask(id: string): TaskRecord {
    const task = store.getTask(id);
    if (!task) throw notFound(KANBAN_ERROR.taskNotFound, id);
    return task;
  }

  function parseAssignee(value: unknown): TaskRecord['assignee'] {
    if (value === null || value === undefined || value === '') return null;
    if (!isPlainObject(value) || (value.kind !== 'openclaw' && value.kind !== 'external') || typeof value.id !== 'string' || !value.id.trim()) {
      throw invalid('assignee');
    }
    return { kind: value.kind, id: value.id.trim() };
  }

  function parseWorkspace(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw invalid('workspace_path');
    return path.resolve(value);
  }

  /** 正在跑的派活：先落库 canceled，再中止（迟到的结果看到的是终态，写不回任务）。 */
  function cancelActiveRun(taskId: string, reason: string) {
    const active = controllers.get(taskId);
    const run = store.activeRun(taskId);
    if (run) store.finishRun(run.id, 'canceled', null, reason);
    if (active) {
      active.controller.abort();
      void Promise.resolve(runner.abort(active.sessionId)).catch(() => undefined);
    }
  }

  function apply(taskId: string, action: string, body: Record<string, unknown>): TaskRecord {
    const task = requireTask(taskId);
    const guarded = (from: readonly string[], to: KanbanStatus, extra: { result?: string | null } = {}) => {
      if (!from.includes(task.status)) throw badTransition(task.status, action);
      if (!store.transition(taskId, from, to, extra)) throw badTransition(requireTask(taskId).status, action);
    };
    switch (action) {
      case 'move': {
        const to = body.status as KanbanStatus;
        if (!KANBAN_STATUSES.includes(to)) throw invalid('status');
        if (!MOVE_TRANSITIONS[task.status].includes(to)) throw badTransition(task.status, `move:${to}`);
        guarded([task.status], to);
        break;
      }
      case 'complete': {
        const summary = typeof body.summary === 'string' ? body.summary.slice(0, 20_000) : null;
        if (task.status === 'running') cancelActiveRun(taskId, 'completed by operator');
        guarded(ACTION_FROM.complete, 'done', { result: summary || null });
        break;
      }
      case 'block': {
        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
        if (!reason) throw new AutomationError(400, KANBAN_ERROR.reasonRequired, 'reason required');
        if (task.status === 'running') cancelActiveRun(taskId, `blocked: ${reason}`);
        guarded(ACTION_FROM.block, 'blocked');
        store.addEvent(taskId, 'blocked_reason', { reason });
        break;
      }
      case 'unblock':
        guarded(ACTION_FROM.unblock, 'ready');
        break;
      case 'reclaim':
        cancelActiveRun(taskId, typeof body.reason === 'string' && body.reason ? body.reason : 'reclaimed');
        guarded(ACTION_FROM.reclaim, 'ready');
        break;
      case 'archive':
        guarded(ACTION_FROM.archive, 'archived');
        break;
      case 'dispatch':
        return dispatch(taskId);
      default:
        throw invalid('action');
    }
    store.addEvent(taskId, action, { from: task.status });
    return requireTask(taskId);
  }

  function buildPrompt(task: TaskRecord): string {
    const comments = store.comments(task.id);
    return [
      '[Kanban task]',
      `Title: ${task.title}`,
      `Priority: ${task.priority}`,
      task.body ? `\n${task.body}` : '',
      comments.length ? `\n[Comments]\n${comments.map((comment) => `${comment.author}: ${comment.body}`).join('\n')}` : '',
      '\nComplete the task and reply with the result.',
    ].filter(Boolean).join('\n');
  }

  function dispatch(taskId: string): TaskRecord {
    const task = requireTask(taskId);
    if (!ACTION_FROM.dispatch.includes(task.status as 'ready')) throw badTransition(task.status, 'dispatch');
    if (!task.assignee) throw new AutomationError(409, KANBAN_ERROR.assigneeRequired, 'assignee required');
    const agentRef: WorkflowAgentRef = { kind: task.assignee.kind, id: task.assignee.id, ...(task.assignee.kind === 'external' ? { runtime: task.assignee.id } : {}) };
    const availability = deps.directory.availability(agentRef);
    if (!availability.available) throw new AutomationError(409, 'workflows.agentUnavailable', availability.reason, { agent: agentRef.id });
    if (!store.transition(taskId, ACTION_FROM.dispatch, 'running')) throw badTransition(requireTask(taskId).status, 'dispatch');

    const sessionId = randomUUID();
    const run = store.createRun(taskId, agentRef, sessionId);
    store.addEvent(taskId, 'dispatched', { agent: agentRef.id }, run.id);
    const workspace = task.workspacePath ?? deps.defaultWorkspace(taskId);
    try {
      fs.mkdirSync(workspace, { recursive: true });
    } catch {
      // 目录建不了交给 Agent 自己失败
    }
    const controller = new AbortController();
    const done = (async () => {
      let result;
      try {
        result = await runner.runAndWait({
          sessionId, agentRef, input: [{ type: 'text', text: buildPrompt(task) }], workspace,
          timeoutMs: DISPATCH_TIMEOUT_MS, autoApprove: 'once', signal: controller.signal,
        });
      } catch (error) {
        result = { ok: false, output: '', error: (error as Error)?.message ?? 'dispatch failed', sessionId };
      }
      // 运行已被人工收尾（canceled）：结果不写回任务。
      if (!store.finishRun(run.id, result.ok ? 'completed' : 'failed', result.ok ? result.output : null, result.ok ? null : result.error ?? 'failed')) return;
      if (result.ok) {
        if (store.transition(taskId, ['running'], 'review', { result: result.output })) store.addEvent(taskId, 'run_completed', {}, run.id);
      } else if (store.transition(taskId, ['running'], 'blocked')) {
        store.addEvent(taskId, 'run_failed', { error: result.error ?? 'failed' }, run.id);
      }
    })().finally(() => controllers.delete(taskId));
    controllers.set(taskId, { runId: run.id, sessionId, controller, done });
    return requireTask(taskId);
  }

  function assertNoCycle(parentId: string, childId: string) {
    if (parentId === childId) throw new AutomationError(409, KANBAN_ERROR.linkCycle, 'self link');
    const stack = [childId];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (id === parentId) throw new AutomationError(409, KANBAN_ERROR.linkCycle, 'cycle');
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...store.children(id));
    }
  }

  return {
    listBoards: () => store.listBoards(),
    /** 不存在返回 null（授权守卫先取任务再判）。 */
    getTask: (id: string) => store.getTask(id),
    createBoard(body: Record<string, unknown>) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80) throw invalid('name');
      return store.createBoard(name, typeof body.description === 'string' ? body.description.slice(0, 500) : '');
    },
    updateBoard(id: string, body: Record<string, unknown>) {
      if (!store.getBoard(id)) throw notFound(KANBAN_ERROR.boardNotFound, id);
      if (body.archived === true && id === DEFAULT_BOARD_ID) throw new AutomationError(409, KANBAN_ERROR.defaultBoardProtected, id);
      const name = body.name !== undefined ? String(body.name).trim() : undefined;
      if (name !== undefined && (!name || name.length > 80)) throw invalid('name');
      return store.updateBoard(id, { name, description: typeof body.description === 'string' ? body.description.slice(0, 500) : undefined, archived: typeof body.archived === 'boolean' ? body.archived : undefined });
    },

    listTasks(boardId: string, query: Record<string, unknown>) {
      store.ensureDefaultBoard();
      if (!store.getBoard(boardId)) throw notFound(KANBAN_ERROR.boardNotFound, boardId);
      const statuses = uniqueStrings(typeof query.status === 'string' ? query.status.split(',') : query.status).filter((s) => KANBAN_STATUSES.includes(s as KanbanStatus));
      return store.listTasks(boardId, {
        statuses,
        assigneeId: typeof query.assignee === 'string' && query.assignee ? query.assignee : undefined,
        query: typeof query.q === 'string' && query.q.trim() ? query.q.trim().slice(0, 100) : undefined,
      });
    },

    createTask(boardId: string, body: Record<string, unknown>) {
      store.ensureDefaultBoard();
      if (!store.getBoard(boardId)) throw notFound(KANBAN_ERROR.boardNotFound, boardId);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 200) throw invalid('title');
      const status = body.status === undefined ? (body.triage === true ? 'triage' : 'todo') : body.status;
      if (!['triage', 'todo', 'ready', 'scheduled'].includes(String(status))) throw invalid('status');
      const task = store.createTask({
        boardId,
        title,
        body: typeof body.body === 'string' ? body.body.slice(0, 50_000) : '',
        assignee: parseAssignee(body.assignee),
        status: status as KanbanStatus,
        priority: clampInt(body.priority, -100, 100, 0),
        workspacePath: parseWorkspace(body.workspace_path ?? body.workspacePath),
      });
      store.addEvent(task.id, 'created', { status });
      return task;
    },

    detail(taskId: string) {
      const task = requireTask(taskId);
      return {
        task,
        comments: store.comments(taskId),
        events: store.events(taskId),
        runs: store.runs(taskId),
        parents: store.parents(taskId),
        children: store.children(taskId),
      };
    },

    updateTask(taskId: string, body: Record<string, unknown>) {
      const task = requireTask(taskId);
      const patch: Parameters<KanbanStore['updateTask']>[1] = {};
      if (body.title !== undefined) {
        const title = String(body.title).trim();
        if (!title || title.length > 200) throw invalid('title');
        patch.title = title;
      }
      if (body.body !== undefined) patch.body = String(body.body).slice(0, 50_000);
      if (body.priority !== undefined) patch.priority = clampInt(body.priority, -100, 100, task.priority);
      if (body.workspace_path !== undefined || body.workspacePath !== undefined) patch.workspacePath = parseWorkspace(body.workspace_path ?? body.workspacePath);
      if (body.assignee !== undefined) {
        if (task.status === 'running') throw badTransition(task.status, 'assign');
        patch.assignee = parseAssignee(body.assignee);
        store.addEvent(taskId, 'assigned', { assignee: patch.assignee?.id ?? null });
      }
      return store.updateTask(taskId, patch);
    },

    act: apply,

    comment(taskId: string, body: Record<string, unknown>) {
      requireTask(taskId);
      const text = typeof body.body === 'string' ? body.body.trim() : '';
      if (!text || text.length > 20_000) throw invalid('body');
      const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim().slice(0, 80) : 'operator';
      return store.addComment(taskId, author, text);
    },

    link(body: Record<string, unknown>) {
      const parentId = String(body.parent_id ?? body.parentId ?? '');
      const childId = String(body.child_id ?? body.childId ?? '');
      requireTask(parentId);
      requireTask(childId);
      assertNoCycle(parentId, childId);
      store.link(parentId, childId);
      store.addEvent(childId, 'linked', { parentId });
    },

    unlink(body: Record<string, unknown>) {
      return store.unlink(String(body.parent_id ?? body.parentId ?? ''), String(body.child_id ?? body.childId ?? ''));
    },

    /** 批量：≤100 条；`action` 为 archive 或 status（done / blocked / ready / archived），可附带改负责人。逐条回报。 */
    bulk(body: Record<string, unknown>) {
      const ids = uniqueStrings(body.ids);
      if (!ids.length) throw invalid('ids');
      if (ids.length > MAX_BULK) throw new AutomationError(400, KANBAN_ERROR.bulkTooLarge, `at most ${MAX_BULK}`, { max: MAX_BULK });
      const hasStatus = body.status !== undefined;
      if ((body.archive === true) === hasStatus && body.assignee === undefined) throw invalid('status');
      if (hasStatus && !['done', 'blocked', 'ready', 'archived'].includes(String(body.status))) throw invalid('status');
      const results: Array<{ id: string; ok: boolean; errorCode?: string }> = [];
      for (const id of ids) {
        try {
          if (body.assignee !== undefined) this.updateTask(id, { assignee: body.assignee });
          if (body.archive === true || body.status === 'archived') apply(id, 'archive', {});
          else if (body.status === 'done') apply(id, 'complete', { summary: body.summary });
          else if (body.status === 'blocked') apply(id, 'block', { reason: body.reason });
          else if (body.status === 'ready') {
            const current = requireTask(id);
            apply(id, ACTION_FROM.unblock.includes(current.status as 'blocked') ? 'unblock' : 'move', { status: 'ready' });
          }
          results.push({ id, ok: true });
        } catch (error) {
          results.push({ id, ok: false, errorCode: error instanceof AutomationError ? error.code : 'kanban.bulkFailed' });
        }
      }
      return { results };
    },

    /** 测试与关停：等某个任务的派活结束。 */
    waitForDispatch: (taskId: string) => controllers.get(taskId)?.done ?? Promise.resolve(),
    async stop() {
      await Promise.allSettled([...controllers.values()].map((entry) => entry.done));
    },
  };
}

export type KanbanService = ReturnType<typeof createKanbanService>;
