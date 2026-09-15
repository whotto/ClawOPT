/**
 * 群协作（P3）的表与列。只加表、加列、加索引（增量同步），经 `DB.connection()` 与核心库共用一个连接。
 *
 * 核心库（core/db）里已有 `group_chats` / `group_members` / `group_messages`；P3 的新增全部住在这里，
 * 不往 db.ts 里继续堆：
 *
 * | 分组 | 内容 |
 * |---|---|
 * | 房间策略 | 归属人、交接策略、摘要模型与节奏、会话种子、运行超时、访客与远程 Agent 策略、邀请码 |
 * | 消息元数据 | 发送人身份、结构化 @（三态）、服务端签发的深度 / 链、发起人、续跑尝试、消息种类 |
 * | 执行队列 | `room_queue`：只为人类消息建行（界面可见位置 + 撤回），执行顺序在内存 worker 里 |
 * | 交接续跑 | `room_handoff_chains / attempts / outbox / deliveries / inbox` |
 * | 摘要 | `room_summaries`：一群一行，CAS + 租约 + generation |
 * | 工作区 | `room_workspace_changes`：每次运行的 diff |
 * | 附件 | `room_attachments`：房间附件登记（配额按它算） |
 * | 访客 | `room_guests` |
 * | 异步委派 | `room_delegations` |
 * | 远程 Agent（host 侧） | `room_relay_pairings`、`room_relay_connectors` |
 */
import type Database from 'better-sqlite3';

const TABLES = `
  CREATE TABLE IF NOT EXISTS room_queue (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    target_member_id TEXT NOT NULL,
    target_name TEXT NOT NULL DEFAULT '',
    requester_kind TEXT NOT NULL,
    requester_user_id INTEGER,
    requester_guest_id TEXT,
    cancel_capability_hash TEXT,
    text_summary TEXT NOT NULL DEFAULT '',
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    last_error TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_queue_message_target ON room_queue(message_id, target_member_id);
  CREATE INDEX IF NOT EXISTS idx_room_queue_group_status ON room_queue(group_id, status, sequence);

  CREATE TABLE IF NOT EXISTS room_handoff_chains (
    chain_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_message_id INTEGER NOT NULL,
    current_depth INTEGER NOT NULL,
    max_depth INTEGER NOT NULL,
    unlimited INTEGER NOT NULL DEFAULT 0,
    target_member_id TEXT NOT NULL,
    target_snapshot TEXT NOT NULL,
    originator_json TEXT NOT NULL,
    status TEXT NOT NULL,
    stop_reason TEXT NOT NULL DEFAULT '',
    continue_used INTEGER NOT NULL DEFAULT 0,
    attempt_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_handoff_chains_group ON room_handoff_chains(group_id, status);

  CREATE TABLE IF NOT EXISTS room_handoff_attempts (
    attempt_id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    source_instance_id TEXT NOT NULL,
    target_member_id TEXT NOT NULL,
    target_snapshot TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    replaces_attempt_id TEXT,
    status TEXT NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_handoff_attempts_active ON room_handoff_attempts(chain_id)
    WHERE status IN ('claimed', 'admitted', 'dispatched');

  CREATE TABLE IF NOT EXISTS room_handoff_outbox (
    attempt_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    available_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_handoff_outbox_status ON room_handoff_outbox(status, available_at);

  CREATE TABLE IF NOT EXISTS room_handoff_deliveries (
    attempt_id TEXT PRIMARY KEY,
    target_member_id TEXT NOT NULL,
    status TEXT NOT NULL,
    admissions INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_handoff_inbox (
    inbox_id TEXT PRIMARY KEY,
    source_instance_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    target_member_id TEXT NOT NULL,
    target_snapshot TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    receipt TEXT NOT NULL,
    status TEXT NOT NULL,
    state_version INTEGER NOT NULL DEFAULT 0,
    executor TEXT NOT NULL DEFAULT 'local',
    lease_until INTEGER NOT NULL DEFAULT 0,
    invocation_started_at INTEGER,
    terminal_message_id INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_handoff_inbox_source_attempt ON room_handoff_inbox(source_instance_id, attempt_id);

  CREATE TABLE IF NOT EXISTS room_summaries (
    group_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL DEFAULT '',
    through_message_id INTEGER,
    summarized_turn_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    version INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    run_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    run_generation INTEGER,
    drain_through_message_id INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_workspace_changes (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    run_marker TEXT NOT NULL,
    parent_message_id INTEGER,
    status TEXT NOT NULL,
    files_changed INTEGER NOT NULL,
    additions INTEGER NOT NULL,
    deletions INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    files_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_workspace_changes_parent ON room_workspace_changes(group_id, parent_message_id);

  CREATE TABLE IF NOT EXISTS room_attachments (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    uploader_kind TEXT NOT NULL,
    uploader_user_id INTEGER,
    uploader_guest_id TEXT,
    uploader_member_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_attachments_stored ON room_attachments(stored_name);
  CREATE INDEX IF NOT EXISTS idx_room_attachments_group ON room_attachments(group_id);

  CREATE TABLE IF NOT EXISTS room_guests (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    token_hash TEXT NOT NULL,
    invite_generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_guests_token ON room_guests(token_hash);
  CREATE INDEX IF NOT EXISTS idx_room_guests_group ON room_guests(group_id);

  CREATE TABLE IF NOT EXISTS room_delegations (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_message_id INTEGER NOT NULL,
    from_member_id TEXT NOT NULL,
    to_member_id TEXT NOT NULL,
    task TEXT NOT NULL,
    originator_json TEXT NOT NULL,
    depth INTEGER NOT NULL,
    chain_id TEXT NOT NULL,
    status TEXT NOT NULL,
    result_message_id INTEGER,
    result_ok INTEGER,
    claim_id TEXT,
    claim_until INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_delegations_status ON room_delegations(status, claim_until);

  CREATE TABLE IF NOT EXISTS room_relay_pairings (
    request_id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    requester_kind TEXT NOT NULL,
    requester_user_id INTEGER,
    requester_guest_id TEXT,
    requester_name TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    ticket_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    descriptor_json TEXT,
    target_origin TEXT,
    member_id TEXT,
    connector_id TEXT,
    failure_reason TEXT,
    decided_by INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ticket_expires_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_room_relay_pairings_group ON room_relay_pairings(group_id, status);

  CREATE TABLE IF NOT EXISTS room_relay_connectors (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    credential_hash TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_user_id INTEGER,
    owner_guest_id TEXT,
    target_origin TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER,
    revoke_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_room_relay_connectors_group ON room_relay_connectors(group_id, status);
`;

const COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  // 房间策略
  ['group_chats', 'owner_user_id', 'INTEGER'],
  ['group_chats', 'handoff_enabled', 'INTEGER NOT NULL DEFAULT 1'],
  ['group_chats', 'handoff_unlimited', 'INTEGER NOT NULL DEFAULT 0'],
  ['group_chats', 'summary_model', "TEXT NOT NULL DEFAULT ''"],
  ['group_chats', 'summary_every_turns', 'INTEGER NOT NULL DEFAULT 20'],
  ['group_chats', 'summary_generation', 'INTEGER NOT NULL DEFAULT 0'],
  ['group_chats', 'session_seed', "TEXT NOT NULL DEFAULT ''"],
  ['group_chats', 'run_idle_timeout_sec', 'INTEGER NOT NULL DEFAULT 600'],
  ['group_chats', 'run_total_budget_sec', 'INTEGER NOT NULL DEFAULT 3600'],
  ['group_chats', 'allow_guest_agents', 'INTEGER NOT NULL DEFAULT 0'],
  ['group_chats', 'max_guest_agents_per_member', 'INTEGER NOT NULL DEFAULT 1'],
  ['group_chats', 'allow_remote_workspace', 'INTEGER NOT NULL DEFAULT 0'],
  ['group_chats', 'invite_code', 'TEXT'],
  ['group_chats', 'invite_created_by', 'INTEGER'],
  ['group_chats', 'invite_generation', 'INTEGER NOT NULL DEFAULT 0'],
  // 消息元数据
  ['group_messages', 'sender_user_id', 'INTEGER'],
  ['group_messages', 'sender_guest_id', 'TEXT'],
  ['group_messages', 'sender_member_id', 'TEXT'],
  ['group_messages', 'structured_mentions', 'TEXT'],
  ['group_messages', 'mention_depth', 'INTEGER NOT NULL DEFAULT 0'],
  ['group_messages', 'handoff_chain_id', 'TEXT'],
  ['group_messages', 'originator_json', 'TEXT'],
  ['group_messages', 'continuation_attempt_id', 'TEXT'],
  ['group_messages', 'message_kind', "TEXT NOT NULL DEFAULT ''"],
  ['group_messages', 'attachments_json', 'TEXT'],
  // 远程 Agent 成员
  ['group_members', 'owner_kind', "TEXT NOT NULL DEFAULT 'room'"],
  ['group_members', 'owner_user_id', 'INTEGER'],
  ['group_members', 'owner_guest_id', 'TEXT'],
  ['group_members', 'connector_id', 'TEXT'],
  ['group_members', 'description', "TEXT NOT NULL DEFAULT ''"],
];

function hasColumn(conn: Database.Database, table: string, column: string): boolean {
  return (conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
}

const applied = new WeakSet<Database.Database>();

/** 幂等：同一个连接只真正跑一次。 */
export function applyRoomSchema(conn: Database.Database): void {
  if (applied.has(conn)) return;
  conn.exec(TABLES);
  for (const [table, column, ddl] of COLUMNS) {
    if (!hasColumn(conn, table, column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  // 邀请码唯一：部分唯一索引（NULL 不参与）。
  conn.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_group_chats_invite_code ON group_chats(invite_code) WHERE invite_code IS NOT NULL');
  // 旧的「链式转发设为 0 = 关闭」迁成显式开关（只迁一次：max_chain_depth 仍为 0 且开关还是缺省 1 的行）。
  conn.exec('UPDATE group_chats SET handoff_enabled = 0, max_chain_depth = 4 WHERE max_chain_depth = 0 AND handoff_enabled = 1');
  applied.add(conn);
}
