/**
 * 自动化模块的全部表。只加表、加列、加索引（增量同步），不在启动时改写已有数据。
 *
 * 表按域分四组：工作流（定义 / 运行 / 三张只追加证据表 / 导入预览 / 入站钩子）、
 * 定时（计划 / 触发占位 / 事件）、出站 Webhook（端点 / outbox / 本机测试收件箱）、看板。
 */
import type Database from 'better-sqlite3';

const STATEMENTS = `
  CREATE TABLE IF NOT EXISTS automation_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    workspace TEXT,
    nodes_json TEXT NOT NULL DEFAULT '[]',
    edges_json TEXT NOT NULL DEFAULT '[]',
    viewport_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflows_updated ON workflows(updated_at);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    workspace TEXT,
    status TEXT NOT NULL,
    start_node_ids_json TEXT NOT NULL DEFAULT '[]',
    input TEXT,
    input_start_node_ids_json TEXT NOT NULL DEFAULT '[]',
    snapshot_nodes_json TEXT NOT NULL,
    snapshot_edges_json TEXT NOT NULL,
    compiled_loops_json TEXT NOT NULL DEFAULT '[]',
    requested_timeout_ms INTEGER,
    deadline_at INTEGER,
    max_concurrency INTEGER NOT NULL DEFAULT 2,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    scheduled_at INTEGER,
    evidence_seq INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    error_code TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

  CREATE TABLE IF NOT EXISTS workflow_node_executions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    iteration_path_json TEXT NOT NULL DEFAULT '[]',
    consumed_edge_evaluation_ids_json TEXT NOT NULL DEFAULT '[]',
    session_id TEXT,
    agent_kind TEXT,
    agent_id TEXT,
    status TEXT NOT NULL,
    prompt_text TEXT,
    output_text TEXT,
    error TEXT,
    sequence INTEGER NOT NULL,
    updated_seq INTEGER NOT NULL,
    remaining_timeout_ms_at_start INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wne_run_exec ON workflow_node_executions(run_id, execution_id);
  CREATE INDEX IF NOT EXISTS idx_wne_run_seq ON workflow_node_executions(run_id, updated_seq);

  CREATE TABLE IF NOT EXISTS workflow_edge_evaluations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    source_execution_id TEXT,
    target_node_id TEXT NOT NULL,
    iteration_path_json TEXT NOT NULL DEFAULT '[]',
    source_outcome TEXT NOT NULL,
    status TEXT NOT NULL,
    route TEXT NOT NULL,
    reason TEXT,
    orchestration_json TEXT NOT NULL,
    condition_evaluation_json TEXT,
    sequence INTEGER NOT NULL,
    evaluated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wee_run_seq ON workflow_edge_evaluations(run_id, sequence);

  CREATE TABLE IF NOT EXISTS workflow_loop_epochs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    loop_id TEXT NOT NULL,
    iteration INTEGER NOT NULL,
    iteration_path_json TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_reason TEXT,
    sequence INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wle_unique ON workflow_loop_epochs(run_id, loop_id, iteration_path_json);
  CREATE INDEX IF NOT EXISTS idx_wle_run_seq ON workflow_loop_epochs(run_id, sequence);

  CREATE TABLE IF NOT EXISTS workflow_import_previews (
    token TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_hooks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    start_node_ids_json TEXT NOT NULL DEFAULT '[]',
    timeout_ms INTEGER,
    last_triggered_at INTEGER,
    last_run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_hooks_wf ON workflow_hooks(workflow_id);

  CREATE TABLE IF NOT EXISTS workflow_hook_nonces (
    hook_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (hook_id, signature)
  );

  CREATE TABLE IF NOT EXISTS workflow_schedules (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    enabled INTEGER NOT NULL DEFAULT 1,
    input TEXT,
    start_node_ids_json TEXT NOT NULL DEFAULT '[]',
    timeout_ms INTEGER,
    last_scheduled_at INTEGER,
    next_run_at INTEGER,
    last_run_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_schedules_due ON workflow_schedules(enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS workflow_schedule_triggers (
    identity TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_schedule_events (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    trigger_identity TEXT,
    scheduled_at INTEGER,
    kind TEXT NOT NULL,
    reason TEXT,
    run_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wse_schedule ON workflow_schedule_events(schedule_id, created_at);

  CREATE TABLE IF NOT EXISTS webhook_endpoints (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    event_types_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    include_content INTEGER NOT NULL DEFAULT 0,
    allow_private_network INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_status INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_endpoint_event ON webhook_outbox(endpoint_id, event_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_endpoint_status ON webhook_outbox(endpoint_id, status, id);

  CREATE TABLE IF NOT EXISTS kanban_boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kanban_tasks (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    assignee_kind TEXT,
    assignee_id TEXT,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    workspace_path TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_kanban_tasks_board ON kanban_tasks(board_id, status);

  CREATE TABLE IF NOT EXISTS kanban_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kanban_comments_task ON kanban_comments(task_id, created_at);

  CREATE TABLE IF NOT EXISTS kanban_events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    run_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_kanban_events_task ON kanban_events(task_id, created_at);

  CREATE TABLE IF NOT EXISTS kanban_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL,
    output TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_kanban_runs_task ON kanban_runs(task_id, started_at);

  CREATE TABLE IF NOT EXISTS kanban_links (
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, child_id)
  );
`;

export function ensureAutomationSchema(db: Database.Database): void {
  db.exec(STATEMENTS);
}
