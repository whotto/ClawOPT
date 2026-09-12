/**
 * 外部成员的派发路径。
 *
 * ## 这是路线 B 的最后一段接线
 *
 * 前面四块（适配层、执行器、库结构、成员锁）都各自测过了，但它们之间还没连起来：
 * `sendToAgent` 仍然无条件走网关那条路，不看 `member.runtime`。这一层就是那个分岔。
 *
 * 外部分支是**完全独立的一条路**，不碰网关路径上的任何一行——那条路上有整套
 * 会话对账、文本快照保护、工具进度 i18n，全是从事故里长出来的，不该为了加一个
 * 分支去动它。
 *
 * ## 会话为什么只在成功时才落库
 *
 * 实测：`--resume` 指向一个不存在的会话会失败退出（`No conversation found with
 * session ID`）。所以失败的那一轮不能把 uuid 写进去——否则**之后每一轮都会**
 * 拿着一个不存在的会话去 resume，永久失败。同理，续话失败时要把映射清掉，
 * 让下一轮重新开始，而不是一直撞同一堵墙。
 */
import { describe, it, expect, vi } from 'vitest';
import { GroupChatEngine } from '../src/group-chat-engine';

type Emitted = { event: string; payload: any };

function makeEngine(overrides: Record<string, any> = {}) {
  const engine: any = Object.create(GroupChatEngine.prototype);
  const emitted: Emitted[] = [];
  const sessions = new Map<string, string>();
  const saved: any[] = [];
  let nextId = 100;

  engine.processingMembers = new Map();
  engine.emitted = emitted;
  engine.sessions = sessions;
  engine.saved = saved;

  engine.db = {
    getExternalSession: (g: string, m: string) => sessions.get(`${g}|${m}`) ?? null,
    setExternalSession: (g: string, m: string, s: string) => { sessions.set(`${g}|${m}`, s); },
    clearExternalSession: (g: string, m: string) => { sessions.delete(`${g}|${m}`); },
    saveGroupMessage: (row: any) => { saved.push(row); return ++nextId; },
    updateGroupMessage: vi.fn(),
    updateGroupMessageSender: vi.fn(),
    getGroupChat: () => ({ id: 'g1', max_chain_depth: 6 }),
  };
  engine.emit = (event: string, payload: any) => { emitted.push({ event, payload }); };
  engine.getPreferredLanguage = () => 'zh-CN';
  Object.assign(engine, overrides);
  return engine;
}

const member = (over: Record<string, any> = {}) => ({
  id: 'm1', group_id: 'g1', agent_id: 'lead-engineer', display_name: 'Lead Engineer',
  role_description: '', position: 0,
  runtime: 'claude-code',
  external_config: JSON.stringify({ workingDir: '/srv/app', model: 'claude-sonnet-5' }),
  ...over,
});

/** 一个假的执行器：记录收到的请求，按脚本回放事件。 */
function fakeRunner(script: { ok: boolean; deltas?: string[]; finalText?: string; errorDetail?: string }) {
  const calls: any[] = [];
  const runner = async (built: any, _adapter: any, opts: any) => {
    calls.push(built);
    for (const text of script.deltas ?? []) opts.onEvent({ kind: 'delta', text });
    if (script.ok) opts.onEvent({ kind: 'final', text: script.finalText, sessionId: 'ignored' });
    return {
      ok: script.ok,
      finalText: script.finalText,
      exitCode: script.ok ? 0 : 1,
      aborted: false,
      timedOut: false,
      errorDetail: script.errorDetail,
    };
  };
  return { runner, calls };
}

describe('sender_id 命名空间', () => {
  it('外部成员的 sender_id 带 ext: 前缀，与 OpenClaw 的 agentId 隔离', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, finalText: '好了' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    const placeholder = engine.saved[0];
    expect(placeholder.sender_id, '外部成员占用了 OpenClaw 的 agentId 命名空间')
      .toBe('ext:claude-code:lead-engineer');
    expect(placeholder.sender_type).toBe('agent');
  });
});

describe('会话生命周期', () => {
  it('首轮开新会话：不 resume，且用一个新的 UUID', async () => {
    const engine = makeEngine();
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    const args: string[] = calls[0].args;
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('成功后把会话落库；第二轮用 --resume 带同一个 UUID', async () => {
    const engine = makeEngine();
    const first = fakeRunner({ ok: true, finalText: 'ok' });
    await engine.runExternalMember('g1', member(), '第一轮', '用户', undefined, first.runner);
    const uuid = first.calls[0].args[first.calls[0].args.indexOf('--session-id') + 1];

    const second = fakeRunner({ ok: true, finalText: 'ok2' });
    await engine.runExternalMember('g1', member(), '第二轮', '用户', undefined, second.runner);

    const args: string[] = second.calls[0].args;
    expect(args, '第二轮没有续话——每轮都按冷起计价，成本差 8.8 倍').toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(uuid);
  });

  it('**失败的那一轮不把会话写进去**——否则之后每轮都拿着不存在的会话去 resume', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: false, errorDetail: 'exit 1' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    expect(engine.db.getExternalSession('g1', 'm1')).toBeNull();
  });

  it('续话失败时清掉映射，让下一轮重新开始，而不是一直撞同一堵墙', async () => {
    const engine = makeEngine();
    engine.db.setExternalSession('g1', 'm1', 'dead-uuid');

    const { runner, calls } = fakeRunner({ ok: false, errorDetail: 'exit 1' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    expect(calls[0].args).toContain('--resume');
    expect(engine.db.getExternalSession('g1', 'm1'), '死会话没清掉，后面每轮都会失败').toBeNull();
  });
});

describe('事件与落库', () => {
  it('增量按 delta 事件广播，形状与网关路径一致', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, deltas: ['第一段', '第二段'], finalText: '第一段第二段' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    const deltas = engine.emitted.filter((e: Emitted) => e.event === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    const last = deltas[deltas.length - 1].payload;
    expect(last.content).toBe('第一段第二段');
    expect(last.sender_id).toBe('ext:claude-code:lead-engineer');
    expect(last.sender_name).toBe('Lead Engineer');
    expect(last.groupId).toBe('g1');
  });

  it('最终文本落库', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, finalText: '最终回答' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);
    expect(engine.db.updateGroupMessage).toHaveBeenCalled();
    const [, content] = (engine.db.updateGroupMessage as any).mock.calls.at(-1);
    expect(content).toBe('最终回答');
  });

  it('失败时消息里给出可分辨的原因，而不是空白气泡', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: false, errorDetail: 'timeout' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    const [, content] = (engine.db.updateGroupMessage as any).mock.calls.at(-1);
    expect(String(content)).toContain('timeout');
  });

  it('工作目录与模型从 external_config 里读出来传下去', async () => {
    const engine = makeEngine();
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    await engine.runExternalMember('g1', member(), '任务', '用户', undefined, runner);

    expect(calls[0].cwd).toBe('/srv/app');
    expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('external_config 是坏 JSON 时不崩，退回默认值', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, finalText: 'ok' });
    await expect(
      engine.runExternalMember('g1', member({ external_config: '{坏掉的' }), '任务', '用户', undefined, runner),
    ).resolves.toBeDefined();
  });
});
