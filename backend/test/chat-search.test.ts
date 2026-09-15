/**
 * Ctrl/Cmd+K 全文检索（FTS5 trigram）在真 SQLite 上的行为：
 * 索引随写入维护（插入 / 改正文 / 删除 / 改会话名 / 删会话）、启动回填、中日韩与短词、AND、排序、
 * 运算符注入、可见性在排序查询里面（看不见的会话不占 limit）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildChatSearchMatchExpression,
  buildChatSearchSnippet,
  flushChatSearchIndex,
  listRecentChatSessions,
  parseChatSearchTerms,
  rebuildChatSearchIndex,
  searchChats,
} from '../src/collab/sessions/chat-search';

let home = '';
let previousHome: string | undefined;
let previousDataDir: string | undefined;
let db: any;
let sql: any;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-chat-search-'));
  previousHome = process.env.HOME;
  previousDataDir = process.env.CLAWOPT_DATA_DIR;
  process.env.HOME = home;
  process.env.CLAWOPT_DATA_DIR = '.chat-search';
  const { DB } = await import('../src/core/db');
  db = new DB();
  sql = db.connection();
});

afterAll(() => {
  process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.CLAWOPT_DATA_DIR;
  else process.env.CLAWOPT_DATA_DIR = previousDataDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const now = '2026-09-15 00:00:00';
function session(id: string, name: string) {
  db.saveSession({ id, name, agentId: id, position: 0, created_at: now, updated_at: now });
}
function message(sessionKey: string, content: string, role = 'user'): number {
  return Number(db.saveMessage({ session_key: sessionKey, role, content }));
}
const ALL = () => (sql.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>).map((row) => row.id);
const search = (query: string, visible = ALL(), limit?: number) => searchChats(sql, { query, visibleSessionIds: visible, limit }).results;

beforeEach(() => {
  sql.exec('DELETE FROM chat_messages; DELETE FROM sessions;');
  flushChatSearchIndex(sql);
});

describe('SQLite 能力', () => {
  it('打包的 SQLite 支持 FTS5 trigram 与 contentless_delete（索引依赖这两项）', () => {
    const version = (sql.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
    const [major, minor] = version.split('.').map(Number);
    expect(major > 3 || (major === 3 && minor >= 43)).toBe(true);
    const tables = (sql.prepare("SELECT sql FROM sqlite_master WHERE name IN ('chat_search_fts', 'chat_search_title_fts')").all() as Array<{ sql: string }>).map((row) => row.sql).join('\n');
    expect(tables).toContain("tokenize='trigram'");
    expect(tables).toContain('contentless_delete=1');
  });
});

describe('索引随写入维护', () => {
  it('插入、改正文、删除、改会话名、删会话都反映在结果里', () => {
    session('s1', 'Alpha');
    const id = message('s1', '部署脚本需要回滚');
    expect(search('部署脚本').map((r) => r.matchedMessageId)).toEqual([id]);

    db.updateMessage(id, '现在改成了灰度发布');
    expect(search('部署脚本')).toEqual([]);
    expect(search('灰度发布').map((r) => r.matchedMessageId)).toEqual([id]);

    db.deleteMessage(id);
    expect(search('灰度发布')).toEqual([]);
    expect(sql.prepare('SELECT count(*) AS n FROM chat_search_dirty').get().n).toBe(0);

    db.saveSession({ id: 's1', name: 'Renamed Beta', agentId: 's1', position: 0, created_at: now, updated_at: now });
    expect(search('Alpha')).toEqual([]);
    expect(search('Beta').map((r) => [r.sessionId, r.matchedField])).toEqual([['s1', 'title']]);

    message('s1', 'still here');
    db.deleteSession('s1');
    expect(search('Beta')).toEqual([]);
    expect(search('still')).toEqual([]);
  });

  it('流式更新只记脏 id，不在触发器里重建索引；检索前才刷', () => {
    session('s1', 'Alpha');
    const id = message('s1', 'hel', 'assistant');
    flushChatSearchIndex(sql);
    for (const text of ['hello', 'hello wor', 'hello world']) db.updateMessage(id, text);
    expect(sql.prepare('SELECT count(*) AS n FROM chat_search_dirty').get().n).toBe(1);
    expect(sql.prepare(`SELECT count(*) AS n FROM chat_search_fts WHERE chat_search_fts MATCH '"world"'`).get().n).toBe(0);
    expect(search('world').map((r) => r.matchedMessageId)).toEqual([id]);
    expect(sql.prepare('SELECT count(*) AS n FROM chat_search_dirty').get().n).toBe(0);
  });

  it('会话命令结果、运行错误、system 行不进索引', () => {
    session('s1', 'Alpha');
    message('s1', '⌘ {"command":"usage","ok":true,"marker":"zebra"}', 'system');
    message('s1', '❌ Error: zebra exploded', 'assistant');
    message('s1', 'zebra notice', 'system');
    expect(search('zebra')).toEqual([]);
    expect(search('ze')).toEqual([]);
  });

  it('启动回填：触发器之前写进去的行在重建后可检索，重复跑结果相同', () => {
    session('s1', 'Alpha');
    message('s1', 'legacy content before index');
    // 模拟「上线前的库」：清空索引与脏表
    sql.exec("INSERT INTO chat_search_fts(chat_search_fts) VALUES ('delete-all'); DELETE FROM chat_search_dirty; DELETE FROM chat_search_title_fts;");
    expect(search('legacy')).toEqual([]);
    expect(search('Alpha')).toEqual([]);
    expect(rebuildChatSearchIndex(sql)).toEqual({ messages: 1, sessions: 1 });
    expect(search('legacy')).toHaveLength(1);
    expect(search('Alpha')).toHaveLength(1);
    rebuildChatSearchIndex(sql);
    expect(search('legacy')).toHaveLength(1);
    expect((sql.prepare('SELECT count(*) AS n FROM chat_search_title_fts').get() as { n: number }).n).toBe(1);
  });
});

describe('查询语义', () => {
  it('中日韩子串（trigram）与 <3 字符的短词回落 LIKE', () => {
    session('s1', '产品经理');
    const id = message('s1', '我们讨论了数据库迁移方案');
    expect(search('库迁移').map((r) => r.matchedMessageId)).toEqual([id]);
    expect(search('迁移').map((r) => r.matchedMessageId)).toEqual([id]);
    expect(search('产品').map((r) => [r.sessionId, r.matchedField])).toEqual([['s1', 'title']]);
    expect(search('HELLO')).toEqual([]);
  });

  it('所有词都要命中（AND），大小写不敏感', () => {
    session('s1', 'One');
    session('s2', 'Two');
    message('s1', 'Redis cache invalidation');
    message('s2', 'redis cluster');
    expect(search('redis cache').map((r) => r.sessionId)).toEqual(['s1']);
    expect(search('REDIS').map((r) => r.sessionId).sort()).toEqual(['s1', 's2']);
    expect(search('redis nothing')).toEqual([]);
  });

  it('排序：会话名完全相同 > 会话名包含 > 消息命中；每个会话只出一行', () => {
    session('m', 'Misc');
    session('c', 'Deploy notes');
    session('e', 'deploy');
    message('m', 'deploy once');
    message('m', 'deploy deploy deploy twice');
    message('c', 'unrelated');
    const results = search('deploy');
    expect(results.map((r) => [r.sessionId, r.matchedField])).toEqual([['e', 'title'], ['c', 'title'], ['m', 'message']]);
    expect(results.filter((r) => r.sessionId === 'm')).toHaveLength(1);
  });

  it('用户输入不会变成 FTS 运算符（引号、NEAR、*、-、:）', () => {
    session('s1', 'Ops');
    message('s1', 'plain words only here');
    for (const query of ['"', '"plain', 'plain"', 'NEAR(plain words)', 'pla*', '-plain', 'body:plain', 'plain OR nope', '(', 'a:b"c*']) {
      expect(() => search(query)).not.toThrow();
    }
    expect(search('plain OR nope')).toEqual([]);
    expect(search('pla*')).toEqual([]);
    expect(buildChatSearchMatchExpression(['NEAR(a', 'b"c'])).toBe('"NEAR(a" AND "b""c"');
  });

  it('切词：去纯标点、去重、最多 20 个词', () => {
    expect(parseChatSearchTerms('  foo  !! Foo bar ... ')).toEqual(['foo', 'bar']);
    expect(parseChatSearchTerms(Array.from({ length: 30 }, (_, i) => `term${i}`).join(' '))).toHaveLength(20);
  });

  it('可见性在排序查询里面：看不见的会话不出现，也不占 limit', () => {
    // 自己的会话先写（id 最小、最不新近）：看不见的会话若在 limit 之后才被过滤，就会把它挤掉
    session('mine', 'Mine');
    message('mine', 'shared keyword alpha');
    for (let i = 0; i < 5; i += 1) {
      session(`hidden-${i}`, `Hidden ${i}`);
      message(`hidden-${i}`, 'shared keyword alpha');
    }
    const results = search('keyword', ['mine'], 1);
    expect(results.map((r) => r.sessionId)).toEqual(['mine']);
    expect(search('keyword', [])).toEqual([]);
    expect(search('Hidden', ['mine'])).toEqual([]);
  });

  it('片段：命中附近、有界、折叠空白', () => {
    const snippet = buildChatSearchSnippet(`${'x'.repeat(500)}\n\nneedle here ${'y'.repeat(500)}`, ['needle']);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('needle here');
    expect([...snippet].length).toBeLessThanOrEqual(162);
    expect(buildChatSearchSnippet('short text', ['short'])).toBe('short text');
  });

  it('最近会话：按最后一条消息排序，只含看得见的', () => {
    session('a', 'A');
    session('b', 'B');
    session('c', 'C');
    message('a', 'first');
    message('b', 'second');
    const recent = listRecentChatSessions(sql, { visibleSessionIds: ['a', 'b', 'c'] });
    expect(recent.map((r) => r.sessionId)).toEqual(['b', 'a', 'c']);
    expect(listRecentChatSessions(sql, { visibleSessionIds: ['a'] }).map((r) => r.sessionId)).toEqual(['a']);
  });
});
