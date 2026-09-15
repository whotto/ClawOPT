import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { applyChatSearchSchema } from './chat-search-schema';
import { applyControlPlaneSchema } from './control-plane-schema';
import { warnIfBetterSqliteNativeBuildHazard } from './native-build-check';

/** 原生插件构建隐患只在进程里查一次（ConfigManager 与应用上下文各开一个 DB）。 */
let nativeBuildChecked = false;

export type GroupChatRow = {
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  process_start_tag?: string;
  process_end_tag?: string;
  max_chain_depth?: number;
  runtime_session_epoch?: number;
  position?: number;
  created_at?: string;
  updated_at?: string;
};

/**
 * 不可续的会话状态。**认不出的状态按可续处理**——不认识不等于坏了，
 * 反过来会让每一轮都冷起（实测冷起比续话贵 8.8 倍）。
 */
export const NON_RESUMABLE_EXTERNAL_SESSION_STATUSES = new Set([
  'failed', 'cancelled', 'denied', 'rejected',
  'hard_timeout', 'idle_timeout', 'startup_timeout',
]);

export function externalSessionStatusAllowsResume(status: unknown): boolean {
  return !NON_RESUMABLE_EXTERNAL_SESSION_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

export type ExternalSessionRow = {
  group_id: string;
  member_id: string;
  session_id: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type GroupMemberRow = {
  id: string;
  group_id: string;
  agent_id: string;
  display_name: string;
  role_description?: string;
  position: number;
  /** 路线 B：'openclaw'（默认）或某个外部运行时，如 'claude-code'。不传表示「不改」。 */
  runtime?: string | null;
  /** 外部运行时的配置，JSON 文本。不传表示「不改」，不是「清空」。 */
  external_config?: string | null;
};

export type GroupMessageRow = {
  id?: number;
  group_id: string;
  sender_type: 'user' | 'agent';
  sender_id?: string;
  sender_name?: string;
  content: string;
  process_content?: string | null;
  mentions?: string;  // JSON array of mentioned agentIds
  model_used?: string;
  parent_id?: number;
  created_at?: string;
};

export type ChatRow = {
  id?: number;
  parent_id?: number;
  session_key: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  process_content?: string | null;
  process_streaming?: boolean | number | null;
  model_used?: string;
  agent_id?: string;
  agent_name?: string;
  created_at?: string;
};

export type MessagePageInfo = {
  limit: number;
  hasMoreOlder: boolean;
  oldestLoadedId: number | null;
  newestLoadedId: number | null;
  nextBeforeId: number | null;
};

export type MessagePageResult<T> = {
  rows: T[];
  pageInfo: MessagePageInfo;
};

export type MessageSearchMatch = {
  id: number;
  anchorBeforeId: number | null;
};

export type AgentRuntimeMode = 'configured' | 'direct';
export type AgentSystemPromptMode = 'system' | 'agent';
export type AgentToolMode = 'full' | 'coding' | 'messaging' | 'minimal' | 'off';

export type SessionRow = {
  id: string;
  name: string;
  agentId: string;
  characterId?: string;
  position: number;
  created_at: number;
  updated_at: number;
  process_start_tag?: string;
  process_end_tag?: string;
  runtime_mode?: AgentRuntimeMode;
  system_prompt_mode?: AgentSystemPromptMode;
  tool_mode?: AgentToolMode;
  /**
   * 外部运行时单聊（P2 集成）：这个会话的 Agent 不是 OpenClaw 网关上的 Agent，而是一个编码类外部运行时
   * （`claude-code` / `codex` / …，与 `group_members.runtime` 同一套取值）。null = 普通 OpenClaw 会话。
   */
  external_runtime?: string | null;
  /** 外部运行时配置（JSON，不含凭据）：mode、scoped 的 model / reasoningEffort、workingDir。 */
  external_config?: string | null;
  /** 续话句柄（UUID，交给适配器当 sessionId）；上一轮失败时换新。 */
  external_session_id?: string | null;
  /** 上一轮成功，下一轮可以续。 */
  external_session_resumable?: number | null;
};

export type CharacterRow = {
  id: string;
  name: string;
  agentId: string;
  avatar?: string;
  systemPrompt?: string;
  model?: string;
  created_at?: number;
};

export type StoredFileRow = {
  id: number;
  session_key?: string | null;
  original_name: string;
  mime_type?: string | null;
  size?: number | null;
  stored_path: string;
  created_at?: string;
};

export type CapabilityCacheRow = {
  key: string;
  value: string;
  openclaw_version?: string | null;
  status: 'success' | 'error';
  error_detail?: string | null;
  updated_at?: string;
};

export type RunSessionRow = {
  session_key: string;
  surface: string;
  runtime: string;
  agent_id: string;
  title: string | null;
  run_count: number;
  started_at: string;
  last_active: string;
  ended_at: string | null;
  end_reason: string | null;
};

export type RunToolCallRow = {
  id: number;
  session_key: string;
  run_id: string;
  run_marker: string;
  call_id: string;
  name: string;
  arguments: string;
  output: string | null;
  status: string | null;
  started_at: number | null;
  completed_at: number | null;
};

export type SessionUsageDbRow = {
  id: number;
  session_key: string;
  run_id: string;
  source: string;
  agent_id: string | null;
  usage_scope: string;
  purpose: string | null;
  model: string | null;
  provider: string | null;
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  created_at: string;
};

export class DB {
  private db: Database.Database;

  constructor() {
    if (!nativeBuildChecked) {
      nativeBuildChecked = true;
      warnIfBetterSqliteNativeBuildHazard();
    }
    const dataDir = process.env.CLAWOPT_DATA_DIR || '.clawopt';
    const base = path.join(process.env.HOME || '.', dataDir);
    fs.mkdirSync(base, { recursive: true });
    const dbPath = path.join(base, 'clawopt.sqlite');
    this.db = new Database(dbPath);

    // WAL：默认的 delete journal 在断电/OOM-kill 时有损坏窗口，且并发读写差
    // （这台机器上后端与备份脚本会同时碰这个库）。synchronous=NORMAL 是 WAL 下的
    // 常规搭配：崩溃最多丢最后一个事务，不会损坏库文件。
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
    } catch (error) {
      console.warn('[DB] 设置 WAL 失败，回落到默认日志模式：', error);
    }

    this.init();
  }

  /**
   * 底层连接，给自带 schema 与仓储的模块用：`core/auth` 的用户与 IP 锁、控制面服务、
   * `automation/` 的工作流 / 定时 / outbox / 看板表。它们的表与迁移住在各自模块里，
   * 不往这个文件继续堆；共享的只有这一个连接与 WAL 设置。
   */
  connection(): Database.Database {
    return this.db;
  }

  /**
   * 在线备份到指定路径。用 SQLite 自己的 backup 而不是 cp——
   * cp 一个正在写入的库会拷到撕裂的中间状态，而这种损坏往往到恢复时才发现。
   */
  backupTo(targetPath: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }

  private init() {
    applyControlPlaneSchema(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS openclaw_capability_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '{}',
        openclaw_version TEXT,
        status TEXT NOT NULL DEFAULT 'success',
        error_detail TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER REFERENCES chat_messages(id),
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        process_content TEXT,
        process_streaming INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        stored_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS quick_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        command TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        agentId TEXT NOT NULL,
        characterId TEXT,
        position INTEGER DEFAULT 0,
        runtime_mode TEXT DEFAULT 'configured',
        system_prompt_mode TEXT DEFAULT 'system',
        tool_mode TEXT DEFAULT 'full',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        agentId TEXT NOT NULL,
        avatar TEXT,
        systemPrompt TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Insert default agents/characters
      INSERT OR IGNORE INTO characters (id, name, agentId, systemPrompt) 
      VALUES ('char_main', '通用助手', 'main', 'You are a helpful AI assistant.');
      
      INSERT OR IGNORE INTO characters (id, name, agentId, systemPrompt) 
      VALUES ('char_coder', '代码专家', 'coder', 'You are an expert software engineer and architect.');

      -- Insert default commands if they don't exist
      INSERT OR IGNORE INTO quick_commands (command, description) VALUES ('/status', '查看 OpenClaw 网关状态');
      INSERT OR IGNORE INTO quick_commands (command, description) VALUES ('/models', '列出模型供应商可进一步变更模型');
      INSERT OR IGNORE INTO quick_commands (command, description) VALUES ('/help', '帮助信息');
      INSERT OR IGNORE INTO quick_commands (command, description) VALUES ('/clear', '清空当前会话');

      CREATE TABLE IF NOT EXISTS group_chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        system_prompt TEXT DEFAULT '',
        process_start_tag TEXT DEFAULT '',
        process_end_tag TEXT DEFAULT '',
        max_chain_depth INTEGER DEFAULT 6,
        runtime_session_epoch INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS group_members (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role_description TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER REFERENCES group_messages(id),
        group_id TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        sender_id TEXT,
        sender_name TEXT,
        content TEXT NOT NULL,
        process_content TEXT,
        mentions TEXT,
        model_used TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      -- 群消息的所有读取都是 group_id 过滤 + id 倒序；没有这个索引时 SQLite
      -- 沿主键倒着扫全表直到凑够一页，群越多越慢。
      CREATE INDEX IF NOT EXISTS idx_group_messages_group_id_id ON group_messages(group_id, id);

      -- 外部 Agent 的会话映射（路线 B）。
      -- 它不是缓存：实测冷起一次 $0.0594、续话 $0.0067，差 8.8 倍。
      -- 丢了这张表就等于每轮都按冷起计价，所以要跟着库一起持久化。
      -- 主键是 (群, 成员)：同一个成员在不同群里是不同的会话，各自独立。
      CREATE TABLE IF NOT EXISTS external_sessions (
        group_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        -- 可续性是**状态判定**，不是「删掉就等于不可续」。行一直留着，
        -- 排障要看得到「这个成员上次为什么失败」。
        status TEXT NOT NULL DEFAULT 'ok',
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, member_id)
      );
    `);

    // Migration: add system_prompt to existing tables
    // 迁移的 catch 只该吞「列已存在」。原来是裸 catch {}，磁盘满、库损坏、
    // 权限不足会被一并咽掉，之后的 SQL 才在运行时炸，且现场已经丢了。
    const addColumn = (sql: string) => {
      try {
        this.db.exec(sql);
      } catch (error: any) {
        const message = String(error?.message || '');
        if (/duplicate column name/i.test(message)) return;
        throw error;
      }
    };

    addColumn("ALTER TABLE group_chats ADD COLUMN system_prompt TEXT DEFAULT ''");

    // 路线 B：群成员多一个运行时维度。默认 'openclaw' 而不是 NULL，
    // 否则每个判断点都要写 `?? 'openclaw'`，迟早有人漏一处。
    addColumn("ALTER TABLE group_members ADD COLUMN runtime TEXT NOT NULL DEFAULT 'openclaw'");
    // 外部运行时的配置（工作目录、模型、工具白名单…），JSON 文本，可为空。
    addColumn("ALTER TABLE group_members ADD COLUMN external_config TEXT");
    addColumn("ALTER TABLE external_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'");
    addColumn("ALTER TABLE external_sessions ADD COLUMN last_error TEXT");

    // Migration: add process tags for transparency feature
    addColumn("ALTER TABLE group_chats ADD COLUMN process_start_tag TEXT DEFAULT ''");
    addColumn("ALTER TABLE group_chats ADD COLUMN process_end_tag TEXT DEFAULT ''");
    addColumn("ALTER TABLE group_messages ADD COLUMN process_content TEXT");
    // Migration: add max_chain_depth
    addColumn("ALTER TABLE group_chats ADD COLUMN max_chain_depth INTEGER DEFAULT 6");
    addColumn("ALTER TABLE group_chats ADD COLUMN runtime_session_epoch INTEGER DEFAULT 0");
    addColumn("ALTER TABLE group_chats ADD COLUMN position INTEGER DEFAULT 0");

    // Backfill stable ordering for legacy group rows that predate the position column.
    try {
      const groupRows = this.db.prepare('SELECT id, position FROM group_chats ORDER BY updated_at DESC').all() as { id: string; position?: number | null }[];
      if (groupRows.length > 1 && groupRows.every((row) => (row.position ?? 0) === 0)) {
        const update = this.db.prepare('UPDATE group_chats SET position = ? WHERE id = ?');
        const transaction = this.db.transaction((items: { id: string }[]) => {
          items.forEach((item, index) => update.run(index, item.id));
        });
        transaction(groupRows);
      }
    } catch (error) {
      // 回填只是让老数据有个稳定顺序，失败不该拦住启动；但要留声，
      // 否则「群组顺序莫名其妙」这类问题查不到根。
      console.warn('[DB] 群组顺序回填失败：', error);
    }

    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN characterId TEXT");
    } catch (e: any) {}

    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN description TEXT");
    } catch (e: any) {}
    
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN position INTEGER DEFAULT 0");
    } catch (e: any) {}

    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN process_start_tag TEXT DEFAULT ''");
    } catch (e: any) {}
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN process_end_tag TEXT DEFAULT ''");
    } catch (e: any) {}
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN runtime_mode TEXT DEFAULT 'configured'");
    } catch (e: any) {}
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN system_prompt_mode TEXT DEFAULT 'system'");
    } catch (e: any) {}
    try {
      this.db.exec("ALTER TABLE sessions ADD COLUMN tool_mode TEXT DEFAULT 'full'");
    } catch (e: any) {}
    // 外部运行时单聊（P2 集成）：列缺省 null，老会话照旧是 OpenClaw 会话。
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN external_runtime TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN external_config TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN external_session_id TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE sessions ADD COLUMN external_session_resumable INTEGER DEFAULT 0"); } catch (e: any) {}

    try {
      this.db.exec("ALTER TABLE characters ADD COLUMN model TEXT");
    } catch (e: any) {}

    // Per-message snapshot columns for chat_messages
    try { this.db.exec("ALTER TABLE chat_messages ADD COLUMN model_used TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE chat_messages ADD COLUMN agent_id TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE chat_messages ADD COLUMN agent_name TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE chat_messages ADD COLUMN parent_id INTEGER REFERENCES chat_messages(id)"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE chat_messages ADD COLUMN process_content TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE chat_messages ADD COLUMN process_streaming INTEGER DEFAULT 0"); } catch (e: any) {}

    // Group message upgrades
    try { this.db.exec("ALTER TABLE group_messages ADD COLUMN model_used TEXT"); } catch (e: any) {}
    try { this.db.exec("ALTER TABLE group_messages ADD COLUMN parent_id INTEGER REFERENCES group_messages(id)"); } catch (e: any) {}

    this.initRunTables(addColumn);
    applyChatSearchSchema(this.db);
  }

  /**
   * 运行协调器的通用表（P1a）。只加表加列，不改老表的既有列。
   *
   * - `run_sessions`：协调器视角的会话行（单聊会话、群里的每个外部成员各一行）。
   *   `ended_at` 只在队列清空时写；新一轮开始时清掉（「重开」）。
   * - `run_tool_calls`：工具调用与结果**成组**写入（同一事务），库里不会出现有调用没结果的行。
   * - `session_usage`：一次计费调用一行。`(session_key, run_id, source)` 上的**部分唯一索引**
   *   加 `INSERT OR IGNORE`：重放、断线续传重复上报同一次调用，也只记一次。
   * - `chat_messages.run_marker` / `group_messages.run_marker`：同一次运行产出的行带同一个标记。
   */
  private initRunTables(addColumn: (sql: string) => void) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS run_sessions (
        session_key TEXT PRIMARY KEY,
        surface TEXT NOT NULL,
        runtime TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        title TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        end_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS run_tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        run_marker TEXT NOT NULL,
        call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT NOT NULL DEFAULT '',
        output TEXT,
        status TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        UNIQUE (run_marker, call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_tool_calls_session ON run_tool_calls(session_key, id);

      CREATE TABLE IF NOT EXISTS session_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        agent_id TEXT,
        usage_scope TEXT NOT NULL DEFAULT 'model_call',
        purpose TEXT,
        model TEXT,
        provider TEXT,
        api_calls INTEGER NOT NULL DEFAULT 1,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_usage_call
        ON session_usage(session_key, run_id, source) WHERE run_id <> '';
      CREATE INDEX IF NOT EXISTS idx_session_usage_session ON session_usage(session_key, id);
    `);
    addColumn('ALTER TABLE chat_messages ADD COLUMN run_marker TEXT');
    addColumn('ALTER TABLE group_messages ADD COLUMN run_marker TEXT');
  }

  // --- Run coordinator store（结构上满足 runtime/coordinator 的 RunStore 端口）---

  ensureRunSession(input: { sessionKey: string; surface: string; runtime: string; agentId: string; title?: string }): void {
    this.db.prepare(`
      INSERT INTO run_sessions (session_key, surface, runtime, agent_id, title, run_count, started_at, last_active, ended_at, end_reason)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)
      ON CONFLICT(session_key) DO UPDATE SET
        runtime = excluded.runtime,
        agent_id = excluded.agent_id,
        title = COALESCE(run_sessions.title, excluded.title),
        run_count = run_sessions.run_count + 1,
        last_active = CURRENT_TIMESTAMP,
        ended_at = NULL,
        end_reason = NULL
    `).run(input.sessionKey, input.surface, input.runtime, input.agentId, input.title ?? null);
  }

  markRunSessionEnded(sessionKey: string, reason: string): void {
    this.db.prepare('UPDATE run_sessions SET ended_at = CURRENT_TIMESTAMP, end_reason = ?, last_active = CURRENT_TIMESTAMP WHERE session_key = ?')
      .run(reason, sessionKey);
  }

  getRunSession(sessionKey: string): RunSessionRow | undefined {
    return this.db.prepare('SELECT * FROM run_sessions WHERE session_key = ?').get(sessionKey) as RunSessionRow | undefined;
  }

  persistToolCalls(calls: Array<{
    sessionKey: string; runId: string; runMarker: string; callId: string; name: string; arguments: string;
    output: string | null; status: string | null; startedAt: number; completedAt: number | null;
  }>): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO run_tool_calls (session_key, run_id, run_marker, call_id, name, arguments, output, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const call of calls) {
        insert.run(call.sessionKey, call.runId, call.runMarker, call.callId, call.name, call.arguments, call.output, call.status, call.startedAt, call.completedAt);
      }
    })();
  }

  /** 删协调器会话的通用行（工作流运行被删时）。`session_usage` 保留——用量是账。 */
  deleteRunSessionData(sessionKey: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM run_tool_calls WHERE session_key = ?').run(sessionKey);
      this.db.prepare('DELETE FROM run_sessions WHERE session_key = ?').run(sessionKey);
    })();
  }

  listRunToolCalls(sessionKey: string): RunToolCallRow[] {
    return this.db.prepare('SELECT * FROM run_tool_calls WHERE session_key = ? ORDER BY id ASC').all(sessionKey) as RunToolCallRow[];
  }

  recordSessionUsage(row: {
    sessionKey: string; callId: string; source: string; agentId: string; scope: string; purpose: string | null;
    model: string | null; provider: string | null; apiCalls: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; costUsd: number | null;
  }): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO session_usage (session_key, run_id, source, agent_id, usage_scope, purpose, model, provider, api_calls,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.sessionKey, row.callId, row.source, row.agentId, row.scope, row.purpose, row.model, row.provider, row.apiCalls,
      row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.reasoningTokens, row.costUsd,
    );
    return result.changes > 0;
  }

  listSessionUsage(sessionKey: string): SessionUsageDbRow[] {
    return this.db.prepare('SELECT * FROM session_usage WHERE session_key = ? ORDER BY id ASC').all(sessionKey) as SessionUsageDbRow[];
  }

  setChatMessagesRunMarker(ids: number[], runMarker: string): void {
    const update = this.db.prepare('UPDATE chat_messages SET run_marker = ? WHERE id = ?');
    this.db.transaction(() => { for (const id of ids) update.run(runMarker, id); })();
  }

  setGroupMessageRunMarker(id: number, runMarker: string): void {
    this.db.prepare('UPDATE group_messages SET run_marker = ? WHERE id = ?').run(runMarker, id);
  }

  // --- Quick Commands ---
  getQuickCommands() {
    return this.db.prepare('SELECT * FROM quick_commands ORDER BY id ASC').all();
  }

  saveQuickCommand(command: string, description: string) {
    return this.db
      .prepare('INSERT INTO quick_commands (command, description) VALUES (?, ?)')
      .run(command, description);
  }

  updateQuickCommand(id: number, command: string, description: string) {
    return this.db
      .prepare('UPDATE quick_commands SET command = ?, description = ? WHERE id = ?')
      .run(command, description, id);
  }

  deleteQuickCommand(id: number) {
    return this.db.prepare('DELETE FROM quick_commands WHERE id = ?').run(id);
  }

  getConfig(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string) {
    this.db
      .prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }

  getCapabilityCache(key: string): CapabilityCacheRow | undefined {
    return this.db
      .prepare('SELECT key, value, openclaw_version, status, error_detail, updated_at FROM openclaw_capability_cache WHERE key = ?')
      .get(key) as CapabilityCacheRow | undefined;
  }

  upsertCapabilityCache(row: {
    key: string;
    value: string;
    openclawVersion?: string | null;
    status?: 'success' | 'error';
    errorDetail?: string | null;
  }) {
    this.db
      .prepare(`
        INSERT INTO openclaw_capability_cache (key, value, openclaw_version, status, error_detail, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          openclaw_version = excluded.openclaw_version,
          status = excluded.status,
          error_detail = excluded.error_detail,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(
        row.key,
        row.value,
        row.openclawVersion || null,
        row.status || 'success',
        row.errorDetail || null,
      );
  }

  markCapabilityCacheError(key: string, errorDetail: string, openclawVersion?: string | null) {
    const existing = this.getCapabilityCache(key);
    this.db
      .prepare(`
        INSERT INTO openclaw_capability_cache (key, value, openclaw_version, status, error_detail, updated_at)
        VALUES (?, ?, ?, 'error', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          openclaw_version = COALESCE(excluded.openclaw_version, openclaw_capability_cache.openclaw_version),
          status = excluded.status,
          error_detail = excluded.error_detail,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(key, existing?.value || '{}', openclawVersion || null, errorDetail);
  }

  saveMessage(row: ChatRow): number | bigint {
    const result = this.db
      .prepare('INSERT INTO chat_messages (session_key, parent_id, role, content, process_content, process_streaming, model_used, agent_id, agent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        row.session_key,
        row.parent_id || null,
        row.role,
        row.content,
        row.process_content || null,
        row.process_streaming ? 1 : 0,
        row.model_used || null,
        row.agent_id || null,
        row.agent_name || null,
      );
    return result.lastInsertRowid;
  }

  updateMessage(id: number, content: string, modelUsed?: string, processContent?: string | null, processStreaming?: boolean | null) {
    if (processContent !== undefined && processStreaming !== undefined) {
      this.db
        .prepare('UPDATE chat_messages SET content = ?, process_content = ?, process_streaming = ?, model_used = ? WHERE id = ?')
        .run(content, processContent || null, processStreaming ? 1 : 0, modelUsed || null, id);
      return;
    }

    if (processContent !== undefined) {
      this.db
        .prepare('UPDATE chat_messages SET content = ?, process_content = ?, model_used = ? WHERE id = ?')
        .run(content, processContent || null, modelUsed || null, id);
      return;
    }

    if (processStreaming !== undefined) {
      this.db
        .prepare('UPDATE chat_messages SET content = ?, process_streaming = ?, model_used = ? WHERE id = ?')
        .run(content, processStreaming ? 1 : 0, modelUsed || null, id);
      return;
    }

    this.db
      .prepare('UPDATE chat_messages SET content = ?, model_used = ? WHERE id = ?')
      .run(content, modelUsed || null, id);
  }

  updateMessageEnvelope(id: number, role: ChatRow['role'], agentId?: string | null, agentName?: string | null) {
    this.db
      .prepare('UPDATE chat_messages SET role = ?, agent_id = ?, agent_name = ? WHERE id = ?')
      .run(role, agentId || null, agentName || null, id);
  }

  /** 单聊消息属于哪个会话（授权用）；没有这条消息返回 null。 */
  getMessageSessionKey(id: number): string | null {
    const row = this.db.prepare('SELECT session_key FROM chat_messages WHERE id = ?').get(id) as { session_key?: string } | undefined;
    return row?.session_key ?? null;
  }

  updateMessageContent(id: number, content: string) {
    this.db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run(content, id);
  }

  deleteMessage(id: number) {
    const selectDescendantIds = this.db.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT ?
        UNION ALL
        SELECT child.id
        FROM chat_messages child
        JOIN subtree ON child.parent_id = subtree.id
      )
      SELECT id FROM subtree
    `);

    const deleteMany = this.db.transaction((messageId: number) => {
      const ids = (selectDescendantIds.all(messageId) as Array<{ id: number }>).map((row) => row.id);
      if (ids.length === 0) {
        return [];
      }

      const placeholders = ids.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`).run(...ids);
      return ids;
    });

    return deleteMany(id);
  }

  private getCursorPage<T extends { id?: number }>(options: {
    table: 'chat_messages' | 'group_messages';
    scopeColumn: 'session_key' | 'group_id';
    scopeValue: string;
    selectSql: string;
    limit: number;
    beforeId?: number | null;
  }): MessagePageResult<T> {
    const pageLimit = Math.max(1, Math.floor(options.limit));
    const queryLimit = pageLimit + 1;
    const beforeClause = typeof options.beforeId === 'number' ? ' AND id < ?' : '';
    const sql =
      `SELECT * FROM (` +
      `SELECT ${options.selectSql} FROM ${options.table} ` +
      `WHERE ${options.scopeColumn} = ?${beforeClause} ` +
      `ORDER BY id DESC LIMIT ?` +
      `) ORDER BY id ASC`;

    const params =
      typeof options.beforeId === 'number'
        ? [options.scopeValue, options.beforeId, queryLimit]
        : [options.scopeValue, queryLimit];

    const rows = this.db.prepare(sql).all(...params) as T[];
    const hasMoreOlder = rows.length > pageLimit;
    const pageRows = hasMoreOlder ? rows.slice(1) : rows;
    const oldestRow = pageRows[0];
    const newestRow = pageRows[pageRows.length - 1];
    const oldestLoadedId = typeof oldestRow?.id === 'number' ? oldestRow.id : null;
    const newestLoadedId = typeof newestRow?.id === 'number' ? newestRow.id : null;

    return {
      rows: pageRows,
      pageInfo: {
        limit: pageLimit,
        hasMoreOlder,
        oldestLoadedId,
        newestLoadedId,
        nextBeforeId: hasMoreOlder ? oldestLoadedId : null,
      },
    };
  }

  private searchMessageMatches(options: {
    table: 'chat_messages' | 'group_messages';
    scopeColumn: 'session_key' | 'group_id';
    scopeValue: string;
    userRoleColumn: 'role' | 'sender_type';
    userRoleValue: 'user';
    query: string;
  }): MessageSearchMatch[] {
    const normalizedQuery = options.query.trim();
    if (!normalizedQuery) return [];

    const sql = `
      SELECT
        current_message.id AS id,
        (
          SELECT MIN(next_message.id)
          FROM ${options.table} next_message
          WHERE next_message.${options.scopeColumn} = current_message.${options.scopeColumn}
            AND next_message.id > current_message.id
            AND next_message.${options.userRoleColumn} = ?
        ) AS anchorBeforeId
      FROM ${options.table} current_message
      WHERE current_message.${options.scopeColumn} = ?
        AND instr(
          lower(
            ${
              options.table === 'group_messages'
                ? "coalesce(current_message.content, '') || '\n' || coalesce(current_message.process_content, '')"
                : "coalesce(current_message.content, '') || '\n' || coalesce(current_message.process_content, '')"
            }
          ),
          lower(?)
        ) > 0
      ORDER BY current_message.id ASC
    `;

    return this.db.prepare(sql).all(
      options.userRoleValue,
      options.scopeValue,
      normalizedQuery
    ) as MessageSearchMatch[];
  }

  getMessages(sessionKey: string, limit = 1000): ChatRow[] {
    return this.getMessagesPage(sessionKey, { limit }).rows;
  }

  getMessagesPage(sessionKey: string, options: { beforeId?: number | null; limit?: number } = {}): MessagePageResult<ChatRow> {
    return this.getCursorPage<ChatRow>({
      table: 'chat_messages',
      scopeColumn: 'session_key',
      scopeValue: sessionKey,
      selectSql: "id, parent_id, session_key, role, content, process_content, process_streaming, model_used, agent_id, agent_name, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at",
      beforeId: options.beforeId,
      limit: options.limit ?? 1000,
    });
  }

  searchMessages(sessionKey: string, query: string): MessageSearchMatch[] {
    return this.searchMessageMatches({
      table: 'chat_messages',
      scopeColumn: 'session_key',
      scopeValue: sessionKey,
      userRoleColumn: 'role',
      userRoleValue: 'user',
      query,
    });
  }

  saveFile(file: {
    sessionKey?: string;
    originalName: string;
    mimeType?: string;
    size?: number;
    storedPath: string;
  }) {
    this.db
      .prepare('INSERT INTO files (session_key, original_name, mime_type, size, stored_path) VALUES (?, ?, ?, ?, ?)')
      .run(file.sessionKey || null, file.originalName, file.mimeType || null, file.size || 0, file.storedPath);
  }

  getFiles(limit = 200) {
    return this.db
      .prepare('SELECT id, session_key, original_name, mime_type, size, stored_path, created_at FROM files ORDER BY id DESC LIMIT ?')
      .all(limit);
  }

  getFilesBySession(sessionKey: string): StoredFileRow[] {
    return this.db
      .prepare('SELECT id, session_key, original_name, mime_type, size, stored_path, created_at FROM files WHERE session_key = ? ORDER BY id ASC')
      .all(sessionKey) as StoredFileRow[];
  }

  getFileByStoredName(filename: string) {
    return this.db
      .prepare('SELECT * FROM files WHERE stored_path LIKE ?')
      .get(`%/${filename}`) as any;
  }

  // --- Characters ---
  getCharacters(): CharacterRow[] {
    return this.db.prepare('SELECT * FROM characters ORDER BY created_at ASC').all() as CharacterRow[];
  }

  saveCharacter(char: CharacterRow) {
    this.db
      .prepare('INSERT INTO characters (id, name, agentId, avatar, systemPrompt, model) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, agentId=excluded.agentId, avatar=excluded.avatar, systemPrompt=excluded.systemPrompt, model=excluded.model')
      .run(char.id, char.name, char.agentId, char.avatar || null, char.systemPrompt || null, char.model || null);
  }

  deleteCharacter(id: string) {
    this.db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  }

  // --- Sessions ---
  saveSession(session: SessionRow) {
    this.db
      .prepare('INSERT INTO sessions (id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode, external_runtime, external_config, external_session_id, external_session_resumable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, agentId=excluded.agentId, characterId=excluded.characterId, position=excluded.position, updated_at=excluded.updated_at, process_start_tag=excluded.process_start_tag, process_end_tag=excluded.process_end_tag, runtime_mode=excluded.runtime_mode, system_prompt_mode=excluded.system_prompt_mode, tool_mode=excluded.tool_mode, external_runtime=excluded.external_runtime, external_config=excluded.external_config, external_session_id=excluded.external_session_id, external_session_resumable=excluded.external_session_resumable')
      .run(
        session.id,
        session.name,
        session.agentId,
        session.characterId || null,
        session.position,
        session.created_at,
        session.updated_at,
        session.process_start_tag || '',
        session.process_end_tag || '',
        session.runtime_mode || 'configured',
        session.system_prompt_mode || 'system',
        session.tool_mode || 'full',
        session.external_runtime || null,
        session.external_config || null,
        session.external_session_id || null,
        session.external_session_resumable ? 1 : 0,
      );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode, external_runtime, external_config, external_session_id, external_session_resumable FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  getSessionByAgentId(agentId: string): SessionRow | undefined {
    return this.db.prepare('SELECT id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode, external_runtime, external_config, external_session_id, external_session_resumable FROM sessions WHERE agentId = ? ORDER BY updated_at DESC LIMIT 1').get(agentId) as SessionRow | undefined;
  }

  getSessions(): SessionRow[] {
    return this.db.prepare('SELECT id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode, external_runtime, external_config, external_session_id, external_session_resumable FROM sessions ORDER BY position ASC, updated_at DESC').all() as SessionRow[];
  }

  updateSessionPositions(orders: { id: string; position: number }[]) {
    const update = this.db.prepare('UPDATE sessions SET position = ? WHERE id = ?');
    const transaction = this.db.transaction((items) => {
      for (const item of items) {
        update.run(item.position, item.id);
      }
    });
    transaction(orders);
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM chat_messages WHERE session_key = ?').run(id);
    // 协调器的通用表跟着会话走；session_usage 保留——用量是账，会话删了账不该跟着消失。
    this.db.prepare('DELETE FROM run_tool_calls WHERE session_key = ?').run(id);
    this.db.prepare('DELETE FROM run_sessions WHERE session_key = ?').run(id);
  }

  // --- Group Chats ---
  saveGroupChat(group: GroupChatRow) {
    this.db
      .prepare('INSERT INTO group_chats (id, name, description, system_prompt, process_start_tag, process_end_tag, max_chain_depth, runtime_session_epoch, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, system_prompt=excluded.system_prompt, process_start_tag=excluded.process_start_tag, process_end_tag=excluded.process_end_tag, max_chain_depth=excluded.max_chain_depth, runtime_session_epoch=excluded.runtime_session_epoch, position=excluded.position, updated_at=excluded.updated_at')
      .run(group.id, group.name, group.description || '', group.system_prompt || '', group.process_start_tag || '', group.process_end_tag || '', group.max_chain_depth ?? 6, group.runtime_session_epoch ?? 0, group.position ?? 0, group.created_at || new Date().toISOString(), group.updated_at || new Date().toISOString());
  }

  getGroupChat(id: string): GroupChatRow | undefined {
    return this.db.prepare('SELECT * FROM group_chats WHERE id = ?').get(id) as GroupChatRow | undefined;
  }

  getGroupChats(): GroupChatRow[] {
    return this.db.prepare('SELECT * FROM group_chats ORDER BY position ASC, updated_at DESC').all() as GroupChatRow[];
  }

  updateGroupChatPositions(orders: { id: string; position: number }[]) {
    const update = this.db.prepare('UPDATE group_chats SET position = ? WHERE id = ?');
    const transaction = this.db.transaction((items: { id: string; position: number }[]) => {
      for (const item of items) {
        update.run(item.position, item.id);
      }
    });
    transaction(orders);
  }

  deleteGroupChat(id: string) {
    this.db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(id);
    this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    // 这个库的级联是手写的，不是 FK 驱动的。新加一张表而忘了在这里补一行，
    // 后果不是报错，是孤儿行在库里越积越多而没人发现。
    this.db.prepare('DELETE FROM external_sessions WHERE group_id = ?').run(id);
    // 群里每个外部成员在协调器里是 `room:<群>:member:<成员>` 一个会话（用量同样保留）。
    // 按前缀比较而不用 LIKE：群 id 里的 `_` / `%` 在 LIKE 里是通配符。
    const roomPrefix = `room:${id}:member:`;
    this.db.prepare('DELETE FROM run_tool_calls WHERE substr(session_key, 1, ?) = ?').run(roomPrefix.length, roomPrefix);
    this.db.prepare('DELETE FROM run_sessions WHERE substr(session_key, 1, ?) = ?').run(roomPrefix.length, roomPrefix);
    this.db.prepare('DELETE FROM group_chats WHERE id = ?').run(id);
  }

  // --- Group Members ---
  saveGroupMember(member: GroupMemberRow) {
    // runtime / external_config 用 COALESCE(excluded.x, group_members.x)：
    // 调用方不传这两项时保持原值。改个显示名的一次保存，不该顺手把成员的
    // 运行时退回 openclaw —— 那种覆盖不会报错，只会让外部 Agent 悄悄变回
    // 普通 Agent，正是 v1.5.0 那类「界面显示得像配好了」的故障形状。
    // 用**具名**参数，不用位置参数：UPDATE 分支要引用调用方传进来的原始值
    // （可能是 null），而 `excluded.runtime` 拿到的是 VALUES 里 COALESCE 之后的
    // 结果，永远不为 null —— 那样写 ON CONFLICT 里的 COALESCE 就形同虚设，
    // 每次保存都会把运行时冲回 openclaw。
    this.db
      .prepare(`INSERT INTO group_members (id, group_id, agent_id, display_name, role_description, position, runtime, external_config)
                VALUES (@id, @group_id, @agent_id, @display_name, @role_description, @position, COALESCE(@runtime, 'openclaw'), @external_config)
                ON CONFLICT(id) DO UPDATE SET
                  display_name=excluded.display_name,
                  role_description=excluded.role_description,
                  position=excluded.position,
                  runtime=COALESCE(@runtime, group_members.runtime),
                  external_config=COALESCE(@external_config, group_members.external_config)`)
      .run({
        id: member.id,
        group_id: member.group_id,
        agent_id: member.agent_id,
        display_name: member.display_name,
        role_description: member.role_description || '',
        position: member.position || 0,
        runtime: member.runtime ?? null,
        external_config: member.external_config ?? null,
      });
  }

  getGroupMembers(groupId: string): GroupMemberRow[] {
    return this.db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY position ASC').all(groupId) as GroupMemberRow[];
  }

  updateGroupMemberAgentId(id: string, agentId: string) {
    return this.db.prepare('UPDATE group_members SET agent_id = ? WHERE id = ?').run(agentId, id);
  }

  deleteGroupMembers(groupId: string) {
    this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
    this.db.prepare('DELETE FROM external_sessions WHERE group_id = ?').run(groupId);
  }

  /** 删掉一个成员，连同它的外部会话——否则留孤儿行。 */
  deleteGroupMember(groupId: string, memberId: string) {
    this.db.prepare('DELETE FROM group_members WHERE id = ?').run(memberId);
    this.db.prepare('DELETE FROM external_sessions WHERE group_id = ? AND member_id = ?').run(groupId, memberId);
  }

  /**
   * 按传入的列表更新群成员。
   *
   * **不是「删光重插」。** 路由原来的做法是 `deleteGroupMembers()` 再整批重插，
   * 而那个方法带级联——连同该群的全部外部会话一起删；成员行也没了，于是
   * `saveGroupMember` 里 `COALESCE(@runtime, group_members.runtime)` 的保护完全失效，
   * 重插时 runtime 落回默认的 'openclaw'。
   *
   * 后果：用户只是改了个群名或调了下顺序，**所有外部成员退回 OpenClaw、会话全丢**，
   * 下一轮按冷起计价（实测贵 8.2 倍），而且没有任何报错。
   *
   * 所以改成增量 upsert：只删真正被移除的成员。`runtime` / `external_config`
   * 不传就保持原值（由 saveGroupMember 的 COALESCE 负责），传了才改。
   */
  replaceGroupMembers(
    groupId: string,
    members: Array<{
      agentId: string; displayName?: string; roleDescription?: string;
      runtime?: string | null; externalConfig?: string | null;
    }>,
  ) {
    const existing = this.getGroupMembers(groupId);
    const keep = new Set<string>();

    members.forEach((m, idx) => {
      const id = `gm_${groupId}_${m.agentId}`;
      keep.add(id);
      this.saveGroupMember({
        id,
        group_id: groupId,
        agent_id: m.agentId,
        display_name: m.displayName || m.agentId,
        role_description: m.roleDescription || '',
        position: idx,
        runtime: m.runtime ?? null,
        external_config: m.externalConfig ?? null,
      });
    });

    for (const row of existing) {
      if (!keep.has(row.id)) this.deleteGroupMember(groupId, row.id);
    }
  }

  // --- 外部 Agent 会话映射 ---
  getExternalSession(groupId: string, memberId: string): string | null {
    const row = this.db
      .prepare('SELECT session_id FROM external_sessions WHERE group_id = ? AND member_id = ?')
      .get(groupId, memberId) as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  }

  setExternalSession(groupId: string, memberId: string, sessionId: string) {
    // 写入即代表这一轮成功：状态回到 ok，上次的错误清掉。
    this.db
      .prepare(`INSERT INTO external_sessions (group_id, member_id, session_id, status, last_error)
                VALUES (?, ?, ?, 'ok', NULL)
                ON CONFLICT(group_id, member_id) DO UPDATE SET
                  session_id=excluded.session_id,
                  status='ok',
                  last_error=NULL,
                  updated_at=CURRENT_TIMESTAMP`)
      .run(groupId, memberId, sessionId);
  }

  /**
   * 把会话标成不可续，但**保留这一行**。
   *
   * 原来的做法是直接删。那能防住「拿着死会话去 resume」，但顺手丢掉了
   * 「上次为什么失败」——而那正是排障最想看的。状态细分到超时的三种，
   * 是因为启动就超时（多半是命令或凭据问题）、跑到一半空闲超时、硬超时，
   * 三者的处置本来就不同。
   */
  markExternalSessionUnusable(groupId: string, memberId: string, status: string, detail?: string) {
    this.db
      .prepare(`UPDATE external_sessions SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE group_id = ? AND member_id = ?`)
      .run(status, detail || null, groupId, memberId);
  }

  getExternalSessionRow(groupId: string, memberId: string): ExternalSessionRow | null {
    const row = this.db
      .prepare('SELECT * FROM external_sessions WHERE group_id = ? AND member_id = ?')
      .get(groupId, memberId) as ExternalSessionRow | undefined;
    return row ?? null;
  }

  /** 只返回**能续**的会话 id；状态不允许续话时返回 null。 */
  getResumableExternalSession(groupId: string, memberId: string): string | null {
    const row = this.getExternalSessionRow(groupId, memberId);
    if (!row) return null;
    return externalSessionStatusAllowsResume(row.status) ? row.session_id : null;
  }

  clearExternalSession(groupId: string, memberId: string) {
    this.db.prepare('DELETE FROM external_sessions WHERE group_id = ? AND member_id = ?').run(groupId, memberId);
  }

  /** 只给诊断用：跨群列出全部成员。 */
  listAllGroupMembers(): GroupMemberRow[] {
    return this.db.prepare('SELECT * FROM group_members').all() as GroupMemberRow[];
  }

  /** 只给诊断用：列出全部外部会话。 */
  listAllExternalSessions(): ExternalSessionRow[] {
    return this.db.prepare('SELECT * FROM external_sessions').all() as ExternalSessionRow[];
  }

  /** 只给用例与诊断用：数一数有没有孤儿行。 */
  countExternalSessions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM external_sessions').get() as { n: number };
    return row?.n ?? 0;
  }

  // --- Group Messages ---
  saveGroupMessage(msg: GroupMessageRow): number {
    const result = this.db
      .prepare('INSERT INTO group_messages (group_id, parent_id, sender_type, sender_id, sender_name, content, process_content, mentions, model_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        msg.group_id,
        msg.parent_id || null,
        msg.sender_type,
        msg.sender_id || null,
        msg.sender_name || null,
        msg.content,
        msg.process_content || null,
        msg.mentions || null,
        msg.model_used || null,
        msg.created_at || new Date().toISOString()
      );
    return Number(result.lastInsertRowid);
  }

  updateGroupMessage(id: number, content: string, modelUsed?: string, mentions?: string | null, processContent?: string | null) {
      if (mentions !== undefined && processContent !== undefined) {
        this.db
          .prepare('UPDATE group_messages SET content = ?, model_used = ?, mentions = ?, process_content = ? WHERE id = ?')
          .run(content, modelUsed || null, mentions, processContent || null, id);
      } else if (mentions !== undefined) {
        this.db
          .prepare('UPDATE group_messages SET content = ?, model_used = ?, mentions = ? WHERE id = ?')
          .run(content, modelUsed || null, mentions, id);
      } else if (processContent !== undefined) {
        this.db
          .prepare('UPDATE group_messages SET content = ?, model_used = ?, process_content = ? WHERE id = ?')
          .run(content, modelUsed || null, processContent || null, id);
      } else {
        this.db
          .prepare('UPDATE group_messages SET content = ?, model_used = ? WHERE id = ?')
          .run(content, modelUsed || null, id);
      }
  }

  updateGroupMessageSender(id: number, senderId?: string | null, senderName?: string | null) {
    this.db
      .prepare('UPDATE group_messages SET sender_id = ?, sender_name = ? WHERE id = ?')
      .run(senderId || null, senderName || null, id);
  }

  deleteGroupMessage(id: number) {
    const selectDescendantRows = this.db.prepare(`
      WITH RECURSIVE subtree(id, parent_id) AS (
        SELECT id, parent_id
        FROM group_messages
        WHERE id = ?
        UNION ALL
        SELECT child.id, child.parent_id
        FROM group_messages child
        JOIN subtree ON child.parent_id = subtree.id
      )
      SELECT id, parent_id FROM subtree
    `);

    const deleteMany = this.db.transaction((messageId: number) => {
      const rows = selectDescendantRows.all(messageId) as Array<{ id: number; parent_id: number | null }>;
      if (rows.length === 0) {
        return [];
      }

      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM group_messages WHERE id IN (${placeholders})`).run(...ids);
      return rows;
    });

    return deleteMany(id);
  }

  deleteGroupMessageDescendants(id: number) {
    const selectDescendantRows = this.db.prepare(`
      WITH RECURSIVE subtree(id, parent_id) AS (
        SELECT id, parent_id
        FROM group_messages
        WHERE parent_id = ?
        UNION ALL
        SELECT child.id, child.parent_id
        FROM group_messages child
        JOIN subtree ON child.parent_id = subtree.id
      )
      SELECT id, parent_id FROM subtree
    `);

    const deleteMany = this.db.transaction((messageId: number) => {
      const rows = selectDescendantRows.all(messageId) as Array<{ id: number; parent_id: number | null }>;
      if (rows.length === 0) {
        return [];
      }

      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(', ');
      this.db.prepare(`DELETE FROM group_messages WHERE id IN (${placeholders})`).run(...ids);
      return rows;
    });

    return deleteMany(id);
  }

  updateGroupMessageParent(id: number, parentId?: number | null) {
    return this.db.prepare('UPDATE group_messages SET parent_id = ? WHERE id = ?').run(parentId ?? null, id);
  }

  getGroupMessages(groupId: string, limit = 1000): GroupMessageRow[] {
    return this.getGroupMessagesPage(groupId, { limit }).rows;
  }

  getLatestGroupMessageId(groupId: string, beforeId?: number): number | undefined {
    const row = beforeId === undefined
      ? this.db
          .prepare('SELECT id FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1')
          .get(groupId) as { id: number } | undefined
      : this.db
          .prepare('SELECT id FROM group_messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT 1')
          .get(groupId, beforeId) as { id: number } | undefined;
    return row?.id;
  }

  getGroupRootMessageIds(groupId: string): number[] {
    return (this.db
      .prepare('SELECT id FROM group_messages WHERE group_id = ? AND parent_id IS NULL ORDER BY id ASC')
      .all(groupId) as { id: number }[])
      .map((row) => row.id);
  }

  getGroupMessagesPage(groupId: string, options: { beforeId?: number | null; limit?: number } = {}): MessagePageResult<GroupMessageRow> {
    return this.getCursorPage<GroupMessageRow>({
      table: 'group_messages',
      scopeColumn: 'group_id',
      scopeValue: groupId,
      selectSql: "id, parent_id, group_id, sender_type, sender_id, sender_name, content, process_content, mentions, model_used, strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at",
      beforeId: options.beforeId,
      limit: options.limit ?? 1000,
    });
  }

  searchGroupMessages(groupId: string, query: string): MessageSearchMatch[] {
    return this.searchMessageMatches({
      table: 'group_messages',
      scopeColumn: 'group_id',
      scopeValue: groupId,
      userRoleColumn: 'sender_type',
      userRoleValue: 'user',
      query,
    });
  }

  getGroupMessageById(id: number, groupId?: string): GroupMessageRow | undefined {
    if (groupId) {
      return this.db.prepare('SELECT * FROM group_messages WHERE id = ? AND group_id = ?').get(id, groupId) as GroupMessageRow | undefined;
    }
    return this.db.prepare('SELECT * FROM group_messages WHERE id = ?').get(id) as GroupMessageRow | undefined;
  }

  getRecentGroupMessages(groupId: string, limit = 20): GroupMessageRow[] {
    const rows = this.db.prepare('SELECT * FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT ?').all(groupId, limit) as GroupMessageRow[];
    return rows.reverse();
  }

  // --- Reset Methods ---
  deleteMessagesBySession(sessionId: string) {
    return this.db.prepare('DELETE FROM chat_messages WHERE session_key = ?').run(sessionId);
  }

  deleteFilesBySession(sessionId: string) {
    return this.db.prepare('DELETE FROM files WHERE session_key = ?').run(sessionId);
  }

  deleteGroupMessagesByGroup(groupId: string) {
    return this.db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(groupId);
  }
}

export default DB;
