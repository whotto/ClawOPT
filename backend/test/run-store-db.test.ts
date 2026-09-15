/**
 * 协调器通用表在真 SQLite 上的约束：用量的部分唯一索引、工具调用成组写入、会话行重开。
 * 去重靠的是库里的唯一索引，而不是内存里的一个 Set——进程重启、断线续传重复上报都要挡得住。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let home = '';
let previousHome: string | undefined;
let previousDataDir: string | undefined;
let db: any;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-runstore-'));
  previousHome = process.env.HOME;
  previousDataDir = process.env.CLAWOPT_DATA_DIR;
  process.env.HOME = home;
  process.env.CLAWOPT_DATA_DIR = '.runstore';
  const { DB } = await import('../src/core/db');
  db = new DB();
});

afterAll(() => {
  process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.CLAWOPT_DATA_DIR;
  else process.env.CLAWOPT_DATA_DIR = previousDataDir;
  fs.rmSync(home, { recursive: true, force: true });
});

const usageRow = (callId: string, overrides: Record<string, unknown> = {}) => ({
  sessionKey: 's1', callId, source: 'claude-code', agentId: 'ext:claude-code:eng', scope: 'run', purpose: null,
  model: 'claude-sonnet-5', provider: null, apiCalls: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01, ...overrides,
});

describe('session_usage 去重', () => {
  it('同一 (会话, call id, 来源) 只记一次；不同来源或不同会话各记各的', () => {
    expect(db.recordSessionUsage(usageRow('claude:sess:result:1'))).toBe(true);
    expect(db.recordSessionUsage(usageRow('claude:sess:result:1', { inputTokens: 999 }))).toBe(false);
    expect(db.recordSessionUsage(usageRow('claude:sess:result:1', { source: 'codex' }))).toBe(true);
    expect(db.recordSessionUsage(usageRow('claude:sess:result:1', { sessionKey: 's2' }))).toBe(true);
    const rows = db.listSessionUsage('s1');
    expect(rows.map((r: any) => [r.run_id, r.source, r.input_tokens])).toEqual([
      ['claude:sess:result:1', 'claude-code', 10],
      ['claude:sess:result:1', 'codex', 10],
    ]);
  });

  it('索引是部分索引：空 run id 不参与去重（没有确定性 id 的调用不能互相吞掉）', () => {
    expect(db.recordSessionUsage(usageRow('', { sessionKey: 's3' }))).toBe(true);
    expect(db.recordSessionUsage(usageRow('', { sessionKey: 's3' }))).toBe(true);
    expect(db.listSessionUsage('s3')).toHaveLength(2);
  });
});

describe('run_tool_calls 与 run_sessions', () => {
  it('同一组调用一起写；同一 run marker 下重复的 call id 被忽略（CLI 每轮复用 item_2 也不会串到别的运行）', () => {
    const call = (runMarker: string, callId: string) => ({
      sessionKey: 'room:g1:member:m1', runId: `id-${runMarker}`, runMarker, callId, name: 'Read', arguments: '{}',
      output: 'x', status: 'completed', startedAt: 1, completedAt: 2,
    });
    db.persistToolCalls([call('run-a', 'item_2'), call('run-a', 'item_3')]);
    db.persistToolCalls([call('run-a', 'item_2')]);
    db.persistToolCalls([call('run-b', 'item_2')]);
    expect(db.listRunToolCalls('room:g1:member:m1').map((r: any) => [r.run_marker, r.call_id])).toEqual([
      ['run-a', 'item_2'], ['run-a', 'item_3'], ['run-b', 'item_2'],
    ]);
  });

  it('删会话 / 删群时清掉协调器的会话行与工具调用，用量保留；群 id 里的 _ 不当通配符', () => {
    const toolCall = (sessionKey: string) => ({
      sessionKey, runId: 'r', runMarker: `m-${sessionKey}`, callId: 'c', name: 'Read', arguments: '{}',
      output: 'x', status: 'completed', startedAt: 1, completedAt: 2,
    });
    for (const key of ['chat-del', 'room:g_1:member:m1', 'room:gx1:member:m1']) {
      db.ensureRunSession({ sessionKey: key, surface: 'chat', runtime: 'openclaw', agentId: 'main' });
      db.persistToolCalls([toolCall(key)]);
      db.recordSessionUsage(usageRow(`u-${key}`, { sessionKey: key }));
    }
    db.deleteSession('chat-del');
    db.deleteGroupChat('g_1');
    expect(db.getRunSession('chat-del')).toBeUndefined();
    expect(db.listRunToolCalls('chat-del')).toEqual([]);
    expect(db.getRunSession('room:g_1:member:m1')).toBeUndefined();
    expect(db.listRunToolCalls('room:g_1:member:m1')).toEqual([]);
    expect(db.getRunSession('room:gx1:member:m1'), '`g_1` 按 LIKE 会误删 `gx1` 的行').toBeDefined();
    expect(db.listSessionUsage('chat-del')).toHaveLength(1);
    expect(db.listSessionUsage('room:g_1:member:m1')).toHaveLength(1);
  });

  it('新一轮重开会话行（清掉 ended_at），结束时写 end_reason', () => {
    db.ensureRunSession({ sessionKey: 'chat-1', surface: 'chat', runtime: 'openclaw', agentId: 'main', title: 'first' });
    db.markRunSessionEnded('chat-1', 'complete');
    expect(db.getRunSession('chat-1')).toMatchObject({ run_count: 1, end_reason: 'complete' });
    expect(db.getRunSession('chat-1').ended_at).not.toBeNull();
    db.ensureRunSession({ sessionKey: 'chat-1', surface: 'chat', runtime: 'openclaw', agentId: 'main', title: 'second' });
    expect(db.getRunSession('chat-1')).toMatchObject({ run_count: 2, ended_at: null, end_reason: null, title: 'first' });
  });
});
