/**
 * `SessionManager.deleteSession()` 删掉唯一 session 时的副作用（Codex 复核，红线 C 附带项）。
 *
 * 背景：`session-manager.ts` 的 `deleteSession()` 内部会调 `ensureDefaultSession()`——
 * 删掉库里最后一个 session 之后，构造函数用的那条"库是空的就自动建一个默认 session"
 * 逻辑会再跑一次，顺手补回一个新的默认 session。这不是 bug，但 `POST /api/sessions`
 * 在 `provision()` 失败时会调用这条路径来回滚孤儿 session（见 `index.ts:10078`）——
 * 如果回滚发生在"库里只有这一个 session"的时刻，用户会发现自己没删任何东西，
 * 列表里却多了一个陌生的"综合管家"默认会话。这条副作用此前没有任何用例覆盖过。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let prevHome: string | undefined;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-sm-'));
  prevHome = process.env.HOME;
  prevDataDir = process.env.CLAWOPT_DATA_DIR;
  process.env.HOME = tmpHome;
  process.env.CLAWOPT_DATA_DIR = '.clawopt-test';
  vi.resetModules();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevDataDir === undefined) delete process.env.CLAWOPT_DATA_DIR;
  else process.env.CLAWOPT_DATA_DIR = prevDataDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function freshManager() {
  const dbMod = await import('../src/db');
  const smMod = await import('../src/session-manager');
  const db = new (dbMod.default as any)();
  const sessionManager = new smMod.SessionManager(db as any);
  return { db, sessionManager };
}

describe('SessionManager.deleteSession() 删掉唯一 session 时会重建一个默认 session', () => {
  it('库里只有一个（自举出的默认）session 时，删掉它之后列表里又出现一个新的默认 session', async () => {
    const { sessionManager } = await freshManager();

    const before = sessionManager.getAllSessions();
    expect(before.length).toBe(1);
    const originalId = before[0].id;

    const deleted = sessionManager.deleteSession(originalId);
    expect(deleted).toBe(true);

    const after = sessionManager.getAllSessions();
    expect(after.length).toBe(1);
    expect(after[0].id).not.toBe(originalId); // 是重新生成的一个新 session，不是原来那个
    expect(after[0].agentId).toBe('main');
  });

  it('库里有多个 session 时，删掉其中一个不会触发重建（不是唯一的那一个）', async () => {
    const { sessionManager } = await freshManager();
    sessionManager.createSession({ id: 'second-agent', name: 'Second' });

    const before = sessionManager.getAllSessions();
    expect(before.length).toBe(2);

    sessionManager.deleteSession('second-agent');

    const after = sessionManager.getAllSessions();
    expect(after.length).toBe(1);
    expect(after.some(s => s.id === 'second-agent')).toBe(false);
  });
});
