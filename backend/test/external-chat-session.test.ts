/**
 * 外部运行时单聊：会话行上的外部运行时配置 → 适配器请求 → 协调器；投影器落消息行与帧；续话状态只在成功时置可续。
 */
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import type { SessionRow } from '../src/core/db';
import { RunCoordinator } from '../src/runtime/coordinator';
import {
  normalizeExternalSessionConfig,
  parseExternalChatCommand,
  parseExternalSessionConfig,
  runExternalChatTurn,
} from '../src/collab/sessions/external-chat-turn';
import { CHAT_COMMAND_RESULT_PREFIX } from '../src/collab/sessions/chat-command-result';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

function fakeDb(session: SessionRow) {
  const sessions = new Map([[session.id, { ...session }]]);
  const messages = new Map<number, { content: string; role?: string; process?: string | null }>();
  return {
    sessions,
    messages,
    updateMessage: (id: number, content: string, _model: string, process: string | null) => { messages.set(id, { ...(messages.get(id) ?? {}), content, process }); },
    updateMessageEnvelope: (id: number, role: string) => { messages.set(id, { ...(messages.get(id) ?? { content: '' }), role }); },
    deleteMessage: (id: number) => { messages.delete(id); },
    setChatMessagesRunMarker: () => {},
    getSession: (id: string) => sessions.get(id),
    saveSession: (row: SessionRow) => { sessions.set(row.id, { ...row }); },
  };
}

const baseSession = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: 'cc-1', name: 'Claude Code', agentId: 'cc-1', position: 0, created_at: 0, updated_at: 0,
  external_runtime: 'claude-code',
  external_config: JSON.stringify({ mode: 'scoped', model: 'deepseek/deepseek-v4', reasoningEffort: 'high', workingDir: '/work/repo' }),
  external_session_id: '11111111-1111-4111-8111-111111111111',
  external_session_resumable: 0,
  ...over,
});

async function runTurn(session: SessionRow, prompt: string, script: (run: ReturnType<typeof scriptedAdapter>['runs'][number]) => void) {
  const hub = new RealtimeHub();
  const events: RealtimeEvent[] = [];
  hub.listen('t', (event) => events.push(event));
  const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), log: () => {} });
  const { adapter, runs } = scriptedAdapter({ id: 'claude-code' });
  const db = fakeDb(session);
  const requested: string[] = [];
  const frames: any[] = [];
  const turn = runExternalChatTurn({
    db: db as any,
    configManager: { getConfig: () => ({ language: 'en' }) } as any,
    realtime: hub,
    runCoordinator: coordinator,
    createAdapter: (runtime) => { requested.push(runtime); return adapter; },
    defaultWorkspace: () => '/tmp/default',
  }, {
    session, transport: 'ws', res: {} as any, sink: { frame: (f: any) => frames.push(f), end: () => {} } as any,
    prompt, assistantMessageId: 7, runMarkerMessageIds: [6, 7], agentName: 'Claude Code',
  });
  await flush();
  await flush();
  script(runs[0]);
  await turn;
  return { db, events, requested, runs };
}

describe('外部运行时会话配置', () => {
  it('只收认识的键；模式缺省 global；推理强度只收合法值', () => {
    expect(JSON.parse(normalizeExternalSessionConfig({ mode: 'scoped', model: 'a/b', apiKey: 'sk-x', token: 't', reasoningEffort: 'turbo', workingDir: ' /w ' }))).toEqual({ mode: 'scoped', model: 'a/b', workingDir: '/w' });
    expect(parseExternalSessionConfig('{bad')).toEqual({ mode: 'global' });
  });

  it('/compact 带指令、/status、/usage（/context 同 usage）是会话命令；普通文本不是', () => {
    expect(parseExternalChatCommand('/compact 保留结论')).toEqual({ kind: 'compact', instructions: '保留结论' });
    expect(parseExternalChatCommand('/status')).toEqual({ kind: 'status' });
    expect(parseExternalChatCommand('/context')).toEqual({ kind: 'usage' });
    expect(parseExternalChatCommand('/help')).toBeNull();
    expect(parseExternalChatCommand('fix the bug')).toBeNull();
  });
});

describe('一轮外部运行时单聊', () => {
  it('请求带模式、归属、句柄、scoped 选择；正文落行、帧发到 session 主题；成功后置可续', async () => {
    const { db, events, requested, runs } = await runTurn(baseSession(), 'fix the bug', (run) => {
      run.emit({ type: 'response.output_text.delta', item_id: 'm', delta: 'done' });
      run.finish({ kind: 'completed', outputText: 'done' });
    });
    expect(requested).toEqual(['claude-code']);
    const request = runs[0].context.request as any;
    expect(request).toMatchObject({ mode: 'scoped', prompt: 'fix the bug', workspace: '/work/repo', owner: { kind: 'session', sessionId: 'cc-1' }, sessionId: '11111111-1111-4111-8111-111111111111', resume: false, runtimeConfig: { model: 'deepseek/deepseek-v4' }, reasoningEffort: 'high' });
    expect(runs[0].context.proxyMode).toBe('scoped');
    expect(db.messages.get(7)?.content).toBe('done');
    expect(events.filter((e) => e.type === 'chat.frame').map((e: any) => e.payload.frame.type)).toContain('final');
    expect(db.sessions.get('cc-1')?.external_session_resumable).toBe(1);
  });

  it('失败：落结构化错误，换一个新句柄、不可续', async () => {
    const { db } = await runTurn(baseSession({ external_session_resumable: 1 }), 'go', (run) => run.finish({ kind: 'failed', error: 'No conversation found', code: 'runtime.resumeFailed' }));
    expect(db.messages.get(7)).toMatchObject({ role: 'system' });
    expect(db.messages.get(7)?.content).toContain('No conversation found');
    const row = db.sessions.get('cc-1')!;
    expect(row.external_session_resumable).toBe(0);
    expect(row.external_session_id).not.toBe('11111111-1111-4111-8111-111111111111');
  });

  it('/status：命令交给运行时，结果落成结构化 system 消息（不是正文）', async () => {
    const { db, runs } = await runTurn(baseSession({ external_session_resumable: 1 }), '/status', (run) => {
      run.emit({ type: 'session.command', result: { command: 'status', ok: true, status: { model: 'm1', nativeSessionId: 'n1' } } });
      run.finish({ kind: 'completed', outputText: '' });
    });
    expect((runs[0].context.request as any).command).toEqual({ kind: 'status' });
    expect((runs[0].context.request as any).resume).toBe(true);
    const row = db.messages.get(7)!;
    expect(row.role).toBe('system');
    expect(row.content.startsWith(CHAT_COMMAND_RESULT_PREFIX)).toBe(true);
    expect(JSON.parse(row.content.slice(CHAT_COMMAND_RESULT_PREFIX.length))).toMatchObject({ command: 'status', status: { model: 'm1' } });
  });

  it('会话命令失败（例如 global 模式不支持 /usage）：不换句柄、不丢续话', async () => {
    const { db } = await runTurn(baseSession({ external_session_resumable: 1 }), '/usage', (run) => {
      run.emit({ type: 'session.command', result: { command: 'usage', ok: false, error: 'not supported' } });
      run.finish({ kind: 'failed', error: 'not supported' });
    });
    const row = db.sessions.get('cc-1')!;
    expect(row.external_session_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(row.external_session_resumable).toBe(1);
  });

  it('运行中被停（含立即插入）却没出字没调工具：删掉空的助手行，不留空气泡', async () => {
    const { db, events } = await runTurn(baseSession(), 'long task', (run) => {
      run.finish({ kind: 'aborted', reason: 'queue_insertion', synced: true, phase: 'running' });
    });
    expect(db.messages.has(7)).toBe(false);
    expect(events.some((e) => e.type === 'chat.stream.end')).toBe(true);
  });

  it('运行时没登记：结构化错误 runtime.unknown，不提交运行', async () => {
    const session = baseSession({ external_runtime: 'ghost-cli' });
    const db = fakeDb(session);
    const frames: any[] = [];
    const hub = new RealtimeHub();
    await runExternalChatTurn({
      db: db as any, configManager: { getConfig: () => ({}) } as any, realtime: hub,
      runCoordinator: new RunCoordinator({ hub, store: new MemoryRunStore(), log: () => {} }),
      createAdapter: () => null, defaultWorkspace: () => '/tmp',
    }, { session, transport: 'ws', res: {} as any, sink: { frame: (f: any) => frames.push(f), end: () => {} } as any, prompt: 'x', assistantMessageId: 7, runMarkerMessageIds: [7], agentName: 'x' });
    expect(frames[0]).toMatchObject({ type: 'error', messageCode: 'runtime.unknown' });
    expect(db.messages.get(7)?.role).toBe('system');
  });
});
