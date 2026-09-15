/**
 * 单聊全文检索（P1b）的表与触发器：Ctrl/Cmd+K 搜索用。
 *
 * - `chat_search_fts`：消息正文，**contentless**（`content=''` + `contentless_delete=1`）+ `trigram` 分词。
 *   不存正文副本（正文仍只在 `chat_messages`），rowid = `chat_messages.id`；trigram 让中日韩文本不分词也能按子串命中。
 * - `chat_search_title_fts`：会话名 + 会话 id（UNINDEXED），trigram，**存内容**（会话名很小）。
 *   不按 `sessions` 的 rowid 关联：`sessions` 是 TEXT 主键表，隐式 rowid 在 VACUUM（备份走 `VACUUM INTO`）后可能变。
 * - `chat_search_dirty`：待重建索引的消息 id。
 *
 * 为什么消息走「脏表」而不是触发器里直接写 FTS：流式回复每来一个增量就 `UPDATE chat_messages SET content`，
 * 触发器里重建 trigram 索引会让一条长回复的写入代价变成 O(增量数 × 正文长度)。触发器只做一次
 * `INSERT OR IGNORE` 记下 id，真正的索引在检索前与启动一次性任务里批量刷（`collab/sessions/chat-search.ts`）——
 * 刷的代价只和「变过的不同消息数」有关。删除直接从 FTS 删（contentless_delete 下按 rowid 删是廉价的）。
 * 会话名很少变，触发器里直接维护。
 *
 * 只加表不改表，全部 `IF NOT EXISTS`，重复执行无害。单独成文件，`db.ts` 里只有一行调用。
 */
import type Database from 'better-sqlite3';

export function applyChatSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_search_fts USING fts5(
      body, content='', contentless_delete=1, tokenize='trigram'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_search_title_fts USING fts5(
      name, session_id UNINDEXED, tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS chat_search_dirty (
      message_id INTEGER PRIMARY KEY
    );

    CREATE TRIGGER IF NOT EXISTS chat_search_msg_ai AFTER INSERT ON chat_messages BEGIN
      INSERT OR IGNORE INTO chat_search_dirty(message_id) VALUES (new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_search_msg_au AFTER UPDATE OF content ON chat_messages
      WHEN old.content IS NOT new.content BEGIN
      INSERT OR IGNORE INTO chat_search_dirty(message_id) VALUES (new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_search_msg_ad AFTER DELETE ON chat_messages BEGIN
      DELETE FROM chat_search_fts WHERE rowid = old.id;
      DELETE FROM chat_search_dirty WHERE message_id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS chat_search_session_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO chat_search_title_fts(name, session_id) VALUES (new.name, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_search_session_au AFTER UPDATE OF name, id ON sessions
      WHEN old.name IS NOT new.name OR old.id IS NOT new.id BEGIN
      DELETE FROM chat_search_title_fts WHERE session_id = old.id;
      INSERT INTO chat_search_title_fts(name, session_id) VALUES (new.name, new.id);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_search_session_ad AFTER DELETE ON sessions BEGIN
      DELETE FROM chat_search_title_fts WHERE session_id = old.id;
    END;
  `);
}
