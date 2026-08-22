import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

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

export type GroupMemberRow = {
  id: string;
  group_id: string;
  agent_id: string;
  display_name: string;
  role_description?: string;
  position: number;
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

export class DB {
  private db: Database.Database;

  constructor() {
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
   * 在线备份到指定路径。用 SQLite 自己的 backup 而不是 cp——
   * cp 一个正在写入的库会拷到撕裂的中间状态，而这种损坏往往到恢复时才发现。
   */
  backupTo(targetPath: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    this.db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  }

  private init() {
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
      .prepare('INSERT INTO sessions (id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, agentId=excluded.agentId, characterId=excluded.characterId, position=excluded.position, updated_at=excluded.updated_at, process_start_tag=excluded.process_start_tag, process_end_tag=excluded.process_end_tag, runtime_mode=excluded.runtime_mode, system_prompt_mode=excluded.system_prompt_mode, tool_mode=excluded.tool_mode')
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
      );
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  getSessionByAgentId(agentId: string): SessionRow | undefined {
    return this.db.prepare('SELECT id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode FROM sessions WHERE agentId = ? ORDER BY updated_at DESC LIMIT 1').get(agentId) as SessionRow | undefined;
  }

  getSessions(): SessionRow[] {
    return this.db.prepare('SELECT id, name, agentId, characterId, position, created_at, updated_at, process_start_tag, process_end_tag, runtime_mode, system_prompt_mode, tool_mode FROM sessions ORDER BY position ASC, updated_at DESC').all() as SessionRow[];
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
    this.db.prepare('DELETE FROM group_chats WHERE id = ?').run(id);
  }

  // --- Group Members ---
  saveGroupMember(member: GroupMemberRow) {
    this.db
      .prepare('INSERT INTO group_members (id, group_id, agent_id, display_name, role_description, position) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, role_description=excluded.role_description, position=excluded.position')
      .run(member.id, member.group_id, member.agent_id, member.display_name, member.role_description || '', member.position || 0);
  }

  getGroupMembers(groupId: string): GroupMemberRow[] {
    return this.db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY position ASC').all(groupId) as GroupMemberRow[];
  }

  updateGroupMemberAgentId(id: string, agentId: string) {
    return this.db.prepare('UPDATE group_members SET agent_id = ? WHERE id = ?').run(agentId, id);
  }

  deleteGroupMembers(groupId: string) {
    this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
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
