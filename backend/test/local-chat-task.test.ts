/**
 * 直连模型 / 生图迁进协调器（P1b）：本地任务适配器与生图优先包装。
 * - 任务完成 = completed（输出取最后一帧文本）；抛错 = failed；被停（信号 / AbortError）= aborted；
 * - 占用会话：本地任务跑着时同一会话的新提交排队（此前 LocalChatOperationManager 不在协调器里，排不了队）；
 * - 生图优先：出图就结束这一轮，没出图交给内层适配器；
 * - 被停时还没出字：占位行删掉；出过字：按当前文本落终帧。
 */
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import { RunCoordinator, type RunSubmission } from '../src/runtime/coordinator';
import {
  createLocalChatTaskProjection,
  localChatTaskAdapter,
  LocalChatTurnChannel,
  withImageFirst,
} from '../src/collab/sessions/local-chat-task';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

function fakeDb() {
  const rows = new Map<number, { content: string; process?: string | null }>([[7, { content: '' }]]);
  const deleted: number[] = [];
  return {
    rows,
    deleted,
    updateMessage: (id: number, content: string, _model?: string, process?: string | null) => { rows.set(id, { content, process }); },
    updateMessageEnvelope: () => {},
    deleteMessage: (id: number) => { deleted.push(id); rows.delete(id); },
    setChatMessagesRunMarker: () => {},
  };
}

function setup() {
  const hub = new RealtimeHub();
  const events: RealtimeEvent[] = [];
  hub.listen('t', (event) => events.push(event));
  const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), abortGraceMs: 500, log: () => {} });
  const db = fakeDb();
  const submission = (adapter: any, request: any, channel: LocalChatTurnChannel, overrides: Partial<RunSubmission<any>> = {}): RunSubmission<any> => ({
    sessionKey: 's1',
    surface: 'chat',
    topics: ['session:s1'],
    agentId: 'main',
    adapter,
    request,
    projector: (run) => createLocalChatTaskProjection({
      db: db as any, run, channel, messageId: 7, runMarkerMessageIds: [6, 7], agentId: 'main', agentName: 'Main', modelUsed: 'm', resolveErrorModelTag: () => 'm',
    }),
    ...overrides,
  });
  const frames = () => events.filter((e) => e.type === 'chat.frame').map((e) => (e.payload as any).frame);
  return { coordinator, events, db, submission, frames };
}

describe('本地任务适配器', () => {
  it('完成：帧经桥发到会话主题，输出取最后一帧；跑着时同会话新提交排队', async () => {
    const { coordinator, submission, frames, events } = setup();
    const channel = new LocalChatTurnChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = await coordinator.submit(submission(localChatTaskAdapter(), {
      kind: 'direct-runtime',
      channel,
      run: async ({ bridge }: any) => {
        bridge.frame({ type: 'delta', text: 'hel' });
        await gate;
        bridge.frame({ type: 'final', text: 'hello' });
      },
    }, channel), 'queue');
    await flush();
    const queued = await coordinator.submit(submission(scriptedAdapter().adapter, {}, new LocalChatTurnChannel()), 'queue');
    expect(queued.status).toBe('queued');
    release();
    const terminal = await (started as any).completion;
    expect(terminal.outcome).toMatchObject({ kind: 'completed', outputText: 'hello' });
    expect(frames().map((f) => f.text)).toEqual(['hel', 'hello']);
    expect(events.filter((e) => e.type === 'run.completed')).toHaveLength(1);
  });

  it('抛错 = 失败：落结构化错误帧', async () => {
    const { coordinator, submission, frames } = setup();
    const channel = new LocalChatTurnChannel();
    const started = await coordinator.submit(submission(localChatTaskAdapter(), {
      kind: 'direct-runtime', channel, run: async () => { throw new Error('HTTP 401 - bad key'); },
    }, channel), 'queue');
    const terminal = await (started as any).completion;
    expect(terminal.outcome).toMatchObject({ kind: 'failed' });
    expect(frames().at(-1)).toMatchObject({ type: 'error', rawDetail: 'HTTP 401 - bad key' });
  });

  it('被停：还没出字删占位行；出过字按当前文本落终帧（stop 信号传到任务）', async () => {
    const { coordinator, submission, db, frames } = setup();
    const channel = new LocalChatTurnChannel();
    let sawAbort = false;
    await coordinator.submit(submission(localChatTaskAdapter(), {
      kind: 'direct-runtime', channel, run: ({ signal }: any) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => { sawAbort = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      }),
    }, channel), 'queue');
    await flush();
    const result = await coordinator.abort('s1', 'user_stop');
    expect(result.aborted).toBe(true);
    expect(sawAbort).toBe(true);
    expect(db.deleted).toEqual([7]);

    const channel2 = new LocalChatTurnChannel();
    await coordinator.submit(submission(localChatTaskAdapter(), {
      kind: 'direct-runtime', channel: channel2, run: ({ bridge, signal }: any) => new Promise<void>((resolve) => {
        bridge.frame({ type: 'delta', text: 'partial' });
        signal.addEventListener('abort', () => resolve());
      }),
    }, channel2), 'queue');
    await flush();
    await coordinator.abort('s1', 'user_stop');
    expect(db.rows.get(7)?.content).toBe('partial');
    expect(frames().at(-1)).toMatchObject({ type: 'final', text: 'partial' });
  });
});

describe('生图优先', () => {
  it('出图：这一轮结束，内层不启动', async () => {
    const { coordinator, submission } = setup();
    const inner = scriptedAdapter();
    const channel = new LocalChatTurnChannel();
    const adapter = withImageFirst(inner.adapter, async () => ({ handled: true, output: '![img](x.png)' }));
    const started = await coordinator.submit(submission(adapter, {}, channel), 'queue');
    const terminal = await (started as any).completion;
    expect(terminal.outcome).toMatchObject({ kind: 'completed', stopReason: 'image_generated' });
    expect(inner.runs).toHaveLength(0);
  });

  it('没出图：交给内层适配器，内层的结局就是这一轮的结局；中止转给内层', async () => {
    const { coordinator, submission } = setup();
    const inner = scriptedAdapter();
    const channel = new LocalChatTurnChannel();
    const adapter = withImageFirst(inner.adapter, async () => ({ handled: false }));
    const started = await coordinator.submit(submission(adapter, {}, channel), 'queue');
    await flush();
    await flush();
    expect(inner.runs).toHaveLength(1);
    await coordinator.abort('s1', 'user_stop');
    expect(inner.runs[0].interrupts).toEqual(['user_stop']);
    const terminal = await (started as any).completion;
    expect(terminal.outcome.kind).toBe('aborted');
  });
});
