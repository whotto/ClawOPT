import { useCallback, useEffect, useRef, useState } from 'react';
import { bulkTasks, createBoard, createTask, listBoards, listTasks, taskAction } from '../../../api/automationKanban';
import { listWorkflowAgents } from '../../../api/automation';
import { requestJson, type ApiError } from '../../../features/workflow/lib/request';
import type { AgentEntry } from '../../../features/workflow/lib/types';

export const KANBAN_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived'] as const;
export type KanbanStatus = typeof KANBAN_STATUSES[number];

export type Board = { id: string; name: string; description: string; archived: boolean; counts: Record<string, number>; total: number };
export type Task = {
  id: string;
  boardId: string;
  title: string;
  body: string;
  assignee: { kind: 'openclaw' | 'external'; id: string } | null;
  status: KanbanStatus;
  priority: number;
  workspacePath: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

const BOARD_KEY = 'clawopt_kanban_board';
const POLL_MS = 5000;

/** 看板状态：看板、任务、过滤、负责人名册；5 秒轮询，请求序号丢弃过期响应（切看板时不会被旧响应覆盖）。 */
export function useKanban() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardIdState] = useState<string>(() => {
    try { return localStorage.getItem(BOARD_KEY) || 'default'; } catch { return 'default'; }
  });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statusFilter, setStatusFilter] = useState<KanbanStatus[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const sequence = useRef(0);

  const setBoardId = (id: string) => {
    setBoardIdState(id);
    try { localStorage.setItem(BOARD_KEY, id); } catch { /* 只是偏好 */ }
  };

  const reload = useCallback(async () => {
    const token = ++sequence.current;
    const [boardResult, taskResult] = await Promise.all([
      requestJson<{ boards: Board[] }>(listBoards()),
      requestJson<{ tasks: Task[] }>(listTasks(boardId, { assignee: assigneeFilter, q: query })),
    ]);
    if (token !== sequence.current) return;
    if (boardResult.ok) {
      setBoards(boardResult.data.boards);
      if (!boardResult.data.boards.some((board) => board.id === boardId)) setBoardId('default');
    }
    if (taskResult.ok) setTasks(taskResult.data.tasks);
    else if (taskResult.error.status !== 404) setError(taskResult.error);
  }, [boardId, assigneeFilter, query]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    void requestJson<{ agents: AgentEntry[] }>(listWorkflowAgents()).then((result) => {
      if (result.ok) setAgents(result.data.agents);
    });
  }, []);

  const run = async <T,>(request: Promise<Response>): Promise<T | null> => {
    const result = await requestJson<T>(request);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    setError(null);
    void reload();
    return result.data;
  };

  return {
    boards, boardId, setBoardId, tasks: statusFilter.length ? tasks.filter((task) => statusFilter.includes(task.status)) : tasks, allTasks: tasks,
    statusFilter, setStatusFilter, assigneeFilter, setAssigneeFilter, query, setQuery, agents, error, setError, reload,
    createBoard: (name: string) => run<{ board: Board }>(createBoard({ name })),
    createTask: (body: Record<string, unknown>) => run<{ task: Task }>(createTask(boardId, body)),
    act: (taskId: string, action: string, extra: Record<string, unknown> = {}) => run<{ task: Task }>(taskAction(taskId, { action, ...extra })),
    bulk: (body: Record<string, unknown>) => run<{ results: Array<{ id: string; ok: boolean; errorCode?: string }> }>(bulkTasks(body)),
  };
}

export type KanbanController = ReturnType<typeof useKanban>;
