/**
 * P1b 第 8 项：运行时提议的会话标题（`session.title`）经协调器进单聊投影器包装——
 * 只替换没有标题 / 自动标题 / 上一次运行时提议，手动改名永远赢；真的改了才推 `session.title.updated`。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import { RunCoordinator } from '../src/runtime/coordinator';
import { CHAT_LIVE_EVENT_TYPES } from '../src/collab/sessions/chat-run-control-routes';
import { SessionOrgStore } from '../src/collab/sessions/session-org-store';
import { SESSION_TITLE_EVENT, withSessionTitle } from '../src/collab/sessions/session-title';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

function setup() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
  const store = new SessionOrgStore(db);
  const hub = new RealtimeHub();
  const events: RealtimeEvent[] = [];
  hub.listen('t', (event) => events.push(event));
  const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), log: () => {} });
  const turn = async (sessionKey: string, titles: string[]) => {
    const scripted = scriptedAdapter();
    const inner: string[] = [];
    const submitted = await coordinator.submit({
      sessionKey, surface: 'chat', topics: [`session:${sessionKey}`], agentId: 'a', adapter: scripted.adapter, request: {},
      projector: (run) => withSessionTitle(store, run, { onEvent: (event) => { inner.push(event.type); }, finish: () => ({ messageId: 1 }) }),
    }, 'queue');
    await flush();
    const run = scripted.runs[0];
    for (const title of titles) run.emit({ type: 'session.title', title });
    run.finish({ kind: 'completed', outputText: '' } as any);
    await (submitted as any).completion;
    return inner;
  };
  const titleFrames = () => events.filter((e) => e.type === SESSION_TITLE_EVENT).map((e) => e.payload as any);
  return { store, turn, titleFrames };
}

describe('运行时提议的会话标题', () => {
  it('替换自动标题、推帧；同一个标题再提不重复推；内层投影器照样收到事件', async () => {
    const { store, turn, titleFrames } = setup();
    store.recordUserMessageForTitle('s1', 'please look at the build');
    const inner = await turn('s1', ['Build investigation', 'Build investigation']);
    expect(store.getMeta('s1')).toMatchObject({ title: 'Build investigation', titleSource: 'runtime' });
    expect(inner.filter((type) => type === 'session.title')).toHaveLength(2);
    expect(titleFrames()).toEqual([{ sessionId: 's1', title: 'Build investigation', titleSource: 'runtime' }]);
  });

  it('手动改名之后运行时的提议一律不收，也不推帧', async () => {
    const { store, turn, titleFrames } = setup();
    store.proposeTitle('s2', 'My name', 'manual');
    await turn('s2', ['Runtime name']);
    expect(store.getMeta('s2')).toMatchObject({ title: 'My name', titleSource: 'manual' });
    expect(titleFrames()).toEqual([]);
  });

  it('会话实时通道转发这个帧（前端据此重拉组织视图）', () => {
    expect(CHAT_LIVE_EVENT_TYPES.has(SESSION_TITLE_EVENT)).toBe(true);
  });
});
