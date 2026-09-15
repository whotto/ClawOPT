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
import { GroupChatEngine } from '../src/collab/rooms/group-chat-engine';
import { NON_RESUMABLE_EXTERNAL_SESSION_STATUSES as NON_RESUMABLE } from '../src/core/db/db';
import { RealtimeHub } from '../src/core/realtime';
import { RunCoordinator } from '../src/runtime/coordinator';
import { MemoryRunStore } from './helpers/scripted-adapter';
import { createClaudeCodeAdapter, CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_DESCRIPTOR, CLAUDE_CODE_SOURCE_OF_TRUTH } from '../src/runtime/adapters/claude-code';
import type { AdapterRunOutcome } from '../src/runtime/contract';
import { harness, homeFor, MemoryFs } from './runtime/adapters/_helpers/harness';

/** 同一个引擎的几轮共用一份内存文件系统（运行时 home 里的续话状态要跨轮次留着）。 */
let sharedFs = new MemoryFs();

type Emitted = { event: string; payload: any };

function makeEngine(overrides: Record<string, any> = {}) {
  sharedFs = new MemoryFs();
  const engine: any = Object.create(GroupChatEngine.prototype);
  const emitted: Emitted[] = [];
  const sessions = new Map<string, { session_id: string; status: string; last_error: string | null }>();
  const saved: any[] = [];
  let nextId = 100;

  engine.processingMembers = new Map();
  engine.emitted = emitted;
  engine.sessions = sessions;
  engine.saved = saved;

  engine.db = {
    getExternalSessionRow: (g: string, m: string) => sessions.get(`${g}|${m}`) ?? null,
    getResumableExternalSession: (g: string, m: string) => {
      const row = sessions.get(`${g}|${m}`);
      if (!row) return null;
      return NON_RESUMABLE.has(row.status) ? null : row.session_id;
    },
    setExternalSession: (g: string, m: string, id: string) => {
      sessions.set(`${g}|${m}`, { session_id: id, status: 'ok', last_error: null });
    },
    markExternalSessionUnusable: (g: string, m: string, status: string, detail?: string) => {
      const row = sessions.get(`${g}|${m}`);
      if (row) sessions.set(`${g}|${m}`, { ...row, status, last_error: detail ?? null });
    },
    saveGroupMessage: (row: any) => { saved.push(row); return ++nextId; },
    setGroupMessageRunMarker: vi.fn(),
    updateGroupMessage: vi.fn(),
    updateGroupMessageSender: vi.fn(),
    getGroupChat: () => ({ id: 'g1', max_chain_depth: 6, system_prompt: '' }),
    getGroupMessages: () => [],
  };
  engine.emit = (event: string, payload: any) => { emitted.push({ event, payload }); };
  // 外部成员的运行由协调器驱动（P1a 起）；内存存储记下它写了什么。
  engine.runStore = new MemoryRunStore();
  engine.useRunCoordinator(new RunCoordinator({ hub: new RealtimeHub(), store: engine.runStore, log: () => {} }));
  engine.getPreferredLanguage = () => 'zh-CN';
  // buildAgentPrompt 只用到 this 上这两个方法（prompt-baseline.test.ts 同样只桩这两个）。
  engine.canUseHostTakeover = () => false;
  Object.assign(engine, overrides);
  return engine;
}

/** 调用助手：把选项对象的样板收在一处，用例里只写关心的那几项。 */
const runExternal = (engine: any, m: any, runner: any, over: Record<string, any> = {}) =>
  engine.runExternalMember({
    groupId: 'g1', groupName: '测试群', member: m, allMembers: [m],
    triggerMsg: '任务', triggerSenderName: '用户', depth: 0, parentId: undefined,
    ...over,
  }, runner);

const member = (over: Record<string, any> = {}) => ({
  id: 'm1', group_id: 'g1', agent_id: 'lead-engineer', display_name: 'Lead Engineer',
  role_description: '', position: 0,
  runtime: 'claude-code',
  external_config: JSON.stringify({ workingDir: '/srv/app', model: 'claude-sonnet-5' }),
  ...over,
});

/**
 * 一个假的 Claude Code：真的 Claude Code 适配器 + 脚本化进程（按 stream-json 回放）。
 * calls 记下每次起进程的参数、工作目录与写进 stdin 的 prompt。
 */
function fakeRunner(script: { ok: boolean; deltas?: string[]; finalText?: string; errorDetail?: string }) {
  const calls: any[] = [];
  const h = harness({
    executorOptions: {
      onLaunch: (proc) => {
        calls.push({ args: proc.spec.args, cwd: proc.spec.cwd, get stdinData() { return proc.stdin; } });
        setImmediate(() => {
          const sessionId = proc.spec.args[proc.spec.args.indexOf('--session-id') + 1] ?? proc.spec.args[proc.spec.args.indexOf('--resume') + 1];
          for (const text of script.deltas ?? []) {
            proc.line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: sessionId });
          }
          if (script.ok) {
            proc.line({ type: 'result', subtype: 'success', is_error: false, result: script.finalText, session_id: sessionId, uuid: 'r1' });
            proc.close(0);
          } else {
            proc.stderr(`${script.errorDetail ?? 'error'}\n`);
            proc.close(1);
          }
        });
      },
    },
  });
  h.deps.fs = sharedFs;
  return { runner: createClaudeCodeAdapter(h.deps), calls };
}

/** 直接给出结局的适配器替身（中止、空闲超时这类用脚本化进程不好造的结局）。 */
function outcomeAdapter(outcome: AdapterRunOutcome) {
  return {
    id: 'claude-code',
    descriptor: CLAUDE_CODE_DESCRIPTOR,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    sourceOfTruth: CLAUDE_CODE_SOURCE_OF_TRUTH,
    start: () => ({ done: Promise.resolve(outcome), interrupt: async () => ({ synced: true }), status: () => ({ phase: 'finished' as const }) }),
  };
}

describe('sender_id 命名空间', () => {
  it('外部成员的 sender_id 带 ext: 前缀，与 OpenClaw 的 agentId 隔离', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, finalText: '好了' });
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

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
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

    const args: string[] = calls[0].args;
    expect(args).toContain('--session-id');
    expect(args).not.toContain('--resume');
    expect(args[args.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('成功后把会话落库；第二轮用 --resume 带同一个 UUID', async () => {
    const engine = makeEngine();
    const first = fakeRunner({ ok: true, finalText: 'ok' });
    await runExternal(engine, member(), first.runner, { triggerMsg: '第一轮' });
    const uuid = first.calls[0].args[first.calls[0].args.indexOf('--session-id') + 1];

    const second = fakeRunner({ ok: true, finalText: 'ok2' });
    await runExternal(engine, member(), second.runner, { triggerMsg: '第二轮' });

    const args: string[] = second.calls[0].args;
    expect(args, '第二轮没有续话——每轮都按冷起计价，成本差 8.8 倍').toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe(uuid);
  });

  it('首轮失败时会话**建了行但标成不可续**——不会有下一轮拿着不存在的会话去 resume', async () => {
    // 早先的做法是「失败就不写」。改成「写了再标」是为了留痕：
    // 首轮失败往往是配置问题（工作目录、凭据），那一条 last_error 最有价值。
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: false, errorDetail: 'exit 1' });
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

    expect(engine.db.getResumableExternalSession('g1', 'm1')).toBeNull();
  });

  it('续话失败时把会话标成不可续（**行保留**），下一轮重新开始', async () => {
    const engine = makeEngine();
    engine.db.setExternalSession('g1', 'm1', 'dead-uuid');

    const { runner, calls } = fakeRunner({ ok: false, errorDetail: 'exit 1' });
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

    expect(calls[0].args).toContain('--resume');
    expect(engine.db.getResumableExternalSession('g1', 'm1'), '死会话仍被当成可续，后面每轮都会失败').toBeNull();
    // 行要留着：排障得看得到上次为什么失败。
    const row = engine.db.getExternalSessionRow('g1', 'm1');
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('exit 1');
  });

  it('中断与超时各自记成不同的状态，不都塞成 failed', async () => {
    const cases: Array<[AdapterRunOutcome, string]> = [
      [{ kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' }, 'cancelled'],
      [{ kind: 'failed', error: 'no output for 1800 s', code: 'runtime.sessionClosed', stopReason: 'idle_timeout' }, 'idle_timeout'],
      [{ kind: 'failed', error: 'hard', stopReason: 'hard_timeout' }, 'hard_timeout'],
    ];
    for (const [outcome, expected] of cases) {
      const engine = makeEngine();
      engine.db.setExternalSession('g1', 'm1', 'uuid');
      await runExternal(engine, member(), outcomeAdapter(outcome));
      expect(engine.db.getExternalSessionRow('g1', 'm1').status, `${outcome.kind} 被记成了别的状态`).toBe(expected);
    }
  });

  it('成员选了 scoped：请求模式与协调器提交的 proxyMode 都是 scoped（用量才会按仲裁表只信代理），成员配置随请求带给解析器', async () => {
    // 集成 P2 真机：不传 proxyMode 时 scoped 成员的用量记成了 CLI 的估计值（input 0、model 空），代理的真实计费被仲裁丢掉。
    const engine = makeEngine();
    const seen: any[] = [];
    const adapter = {
      ...outcomeAdapter({ kind: 'completed', outputText: 'ok' }),
      start: (context: any) => { seen.push(context); return { done: Promise.resolve({ kind: 'completed', outputText: 'ok' }), interrupt: async () => ({ synced: true }), status: () => ({ phase: 'finished' as const }) }; },
    };
    await runExternal(engine, member({ external_config: JSON.stringify({ mode: 'scoped', model: 'deepseek/deepseek-v4', workingDir: '/srv/app' }) }), adapter);
    expect(seen[0].proxyMode).toBe('scoped');
    expect(seen[0].request).toMatchObject({ mode: 'scoped', runtimeConfig: { model: 'deepseek/deepseek-v4' }, owner: { kind: 'room-member', groupId: 'g1', memberId: 'm1' } });
    await runExternal(engine, member(), adapter);
    expect(seen[1].proxyMode).toBe('global');
  });

  it('库里的运行时没有对应适配器：消息里说清楚，不假装在跑', async () => {
    const engine = makeEngine();
    engine.useRuntimeAdapters(() => null);
    await runExternal(engine, member({ runtime: 'no-such-runtime' }), undefined);
    const [, content] = (engine.db.updateGroupMessage as any).mock.calls.at(-1);
    expect(String(content)).toContain('runtime.unknown');
    expect(engine.emitted.some((e: Emitted) => e.event === 'typing_done')).toBe(true);
  });
});

describe('事件与落库', () => {
  it('增量按 delta 事件广播，形状与网关路径一致', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, deltas: ['第一段', '第二段'], finalText: '第一段第二段' });
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

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
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });
    expect(engine.db.updateGroupMessage).toHaveBeenCalled();
    const [, content] = (engine.db.updateGroupMessage as any).mock.calls.at(-1);
    expect(content).toBe('最终回答');
  });

  it('失败时消息里给出可分辨的原因，而不是空白气泡', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: false, errorDetail: 'timeout' });
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

    const [, content] = (engine.db.updateGroupMessage as any).mock.calls.at(-1);
    expect(String(content)).toContain('timeout');
  });

  it('工作目录与模型从 external_config 里读出来传下去', async () => {
    const engine = makeEngine();
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    await runExternal(engine, member(), runner, { triggerMsg: '任务' });

    expect(calls[0].cwd).toBe('/srv/app');
    expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('claude-sonnet-5');
  });

  it('没配工作目录时落在本群工作区，而不是后端进程的当前目录', async () => {
    // global 模式的外部 CLI 会跳过沙箱执行命令：落到 process.cwd() 等于把 ClawOPT 自己的安装目录交给它。
    const engine = makeEngine({ resolveExternalMemberWorkspace: (groupId: string) => `/data/openclaw/workspace-group-${groupId}` });
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    await runExternal(engine, member({ external_config: JSON.stringify({ model: 'claude-sonnet-5' }) }), runner, { triggerMsg: '任务' });

    expect(calls[0].cwd).toBe('/data/openclaw/workspace-group-g1');
    expect(calls[0].cwd).not.toBe(process.cwd());
  });

  it('external_config 是坏 JSON 时不崩，退回默认值', async () => {
    const engine = makeEngine();
    const { runner } = fakeRunner({ ok: true, finalText: 'ok' });
    await expect(
      runExternal(engine, member({ external_config: '{坏掉的' }), runner),
    ).resolves.toBeDefined();
  });
});

/**
 * `sender_id` 的反向查找 —— 一个我自己引入的静默故障。
 *
 * 为了「别占用 OpenClaw 的 agentId 命名空间」，外部成员的 `sender_id` 写成
 * `ext:<runtime>:<agentId>`。但有三处代码把 `sender_id` **当作 agentId** 回传：
 *
 * 1. `resolveTargetAgentIds` 的兜底分支：用户不带 @ 时「回复上一个发言的 Agent」
 * 2. `POST /api/groups/:id/messages/regenerate`：拿 `targetMsg.sender_id` 去重跑
 * 3. 运行恢复里的 `sourceAgentId`
 *
 * 而 `sendToAgent` 是 `members.find(m => m.agent_id === agentId)`，匹配不上就
 * `return parentId` —— **静默返回**。症状：外部 Agent 刚说完话，用户直接追问
 * 一句（不带 @），群里毫无反应；点「重新生成」也毫无反应。没有报错、没有系统提示。
 *
 * 修法不是去补那三个调用点（「堵一个不堵其余」是这个仓库反复批的），
 * 而是让 `sendToAgent` 的成员查找**两种形式都认**，并在查到之后把 agentId
 * 归一到 `member.agent_id`——否则同一个成员会因为两种写法拿到两把不同的锁。
 */
describe('成员引用的两种写法都要认', () => {
  function engineWithMember(runtime = 'claude-code') {
    const engine: any = Object.create(GroupChatEngine.prototype);
    engine.processingMembers = new Map();
    const members = [
      { id: 'm1', group_id: 'g1', agent_id: 'eng', display_name: 'Eng', runtime, external_config: null, role_description: '', position: 0 },
      { id: 'm2', group_id: 'g1', agent_id: 'main', display_name: '管家', runtime: 'openclaw', external_config: null, role_description: '', position: 1 },
    ];
    return { engine, members };
  }

  it('裸 agent_id 能查到', () => {
    const { engine, members } = engineWithMember();
    expect(engine.resolveMemberByAgentRef(members, 'eng')?.id).toBe('m1');
  });

  it('**ext: 前缀形式也能查到同一个成员**', () => {
    const { engine, members } = engineWithMember();
    expect(
      engine.resolveMemberByAgentRef(members, 'ext:claude-code:eng')?.id,
      '外部成员的 sender_id 回传时查不到人，消息会静默消失',
    ).toBe('m1');
  });

  it('两种写法必须落到**同一把锁**上', () => {
    // 不归一的话，同一个成员会有两把锁，「成员正忙」这条判据整个失效。
    const { engine, members } = engineWithMember();
    const a = engine.resolveMemberByAgentRef(members, 'eng');
    const b = engine.resolveMemberByAgentRef(members, 'ext:claude-code:eng');
    expect(engine.memberLockKey('g1', a.agent_id)).toBe(engine.memberLockKey('g1', b.agent_id));
  });

  it('运行时不同的 ext: 前缀不误匹配', () => {
    const { engine, members } = engineWithMember('claude-code');
    expect(engine.resolveMemberByAgentRef(members, 'ext:codex:eng')).toBeUndefined();
  });

  it('OpenClaw 成员不受影响', () => {
    const { engine, members } = engineWithMember();
    expect(engine.resolveMemberByAgentRef(members, 'main')?.id).toBe('m2');
    expect(engine.resolveMemberByAgentRef(members, 'ext:claude-code:main')).toBeUndefined();
  });

  it('查不到就是查不到，不猜一个最像的', () => {
    const { engine, members } = engineWithMember();
    expect(engine.resolveMemberByAgentRef(members, '不存在')).toBeUndefined();
    expect(engine.resolveMemberByAgentRef(members, 'ext:claude-code:不存在')).toBeUndefined();
  });
});

/**
 * 外部成员也要拿到群上下文，并且要能把话转回去。
 *
 * 这两条是「同群协作」成立与否的分水岭。此前：
 *
 * - 外部成员拿到的 prompt 只有一行 `${发言人}：${内容}`。它既不知道群里有谁，
 *   也看不见上文——**就算它想 @ 别人，也不知道该 @ 谁**。
 * - `runExternalMember` 是个叶子节点：存完消息就 return，全文没有 `parseMentions`、
 *   没有递归。外部 Agent 说「@情报调研 帮我查一下」，那句话只会作为文本停在群里，
 *   没有任何人被叫起来。
 *
 * 结果是协作**单向**：OpenClaw 能把活转给外部，外部转不回来。
 *
 * 两条都复用网关那条路已有的东西（`buildAgentPrompt` / `parseMentions` /
 * `sendToAgent`），不另起一套——两套 prompt 组装迟早分家。
 */
describe('群上下文', () => {
  const roster = () => [
    { id: 'm1', group_id: 'g1', agent_id: 'eng', display_name: 'Lead Engineer', runtime: 'claude-code', external_config: JSON.stringify({ workingDir: '/srv/app' }), role_description: '负责实现', position: 0 },
    { id: 'm2', group_id: 'g1', agent_id: 'intel', display_name: '情报调研', runtime: 'openclaw', external_config: null, role_description: '负责查证', position: 1 },
  ];

  it('**prompt 里带上团队名册**——不知道群里有谁就无从协作', async () => {
    const engine = makeEngine();
    engine.db.getGroupMessages = () => [];
    // 群设定（system_prompt）也要流过去——它是这个群的共同约定。
    engine.db.getGroupChat = () => ({ id: 'g1', max_chain_depth: 6, system_prompt: '本群只讨论后端' });
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    const members = roster();

    await runExternal(engine, members[0], runner, { allMembers: members, remainingDepth: 2 });

    const prompt = calls[0].stdinData ?? calls[0].args[calls[0].args.length - 1];
    expect(prompt, '名册没进 prompt，外部成员不知道能 @ 谁').toContain('情报调研');
    expect(prompt, '群设定没流过去').toContain('本群只讨论后端');
  });

  it('prompt 里带上最近历史', async () => {
    const engine = makeEngine();
    engine.db.getGroupMessages = () => [
      { id: 1, group_id: 'g1', parent_id: null, sender_type: 'user', sender_id: null, sender_name: '用户', content: '上一条历史消息', process_content: '', model_used: '', created_at: '' },
    ];
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    const members = roster();

    await runExternal(engine, members[0], runner, { allMembers: members, remainingDepth: 2 });

    const prompt = calls[0].stdinData ?? calls[0].args[calls[0].args.length - 1];
    expect(prompt, '看不见上文，每一轮都像第一轮').toContain('上一条历史消息');
  });

  it('**剩余深度为 0 时省掉名册并禁止 @**——复用 buildAgentPrompt 白得的正确行为', async () => {
    // 转发额度用完了还把名册给它、还允许它 @，只会让它发出一堆没人接的 @。
    // 这个判断本来就在 buildAgentPrompt 里，复用它就自动继承了。
    const engine = makeEngine();
    engine.db.getGroupMessages = () => [];
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    const members = roster();

    await runExternal(engine, members[0], runner, { allMembers: members, remainingDepth: 0 });

    const prompt = calls[0].stdinData ?? calls[0].args[calls[0].args.length - 1];
    expect(prompt).toContain('禁止@他人');
    expect(prompt).not.toContain('情报调研');
  });

  it('触发消息本身仍在', async () => {
    const engine = makeEngine();
    engine.db.getGroupMessages = () => [];
    const { runner, calls } = fakeRunner({ ok: true, finalText: 'ok' });
    const members = roster();
    await runExternal(engine, members[0], runner, { allMembers: members, triggerMsg: '把这件事查清楚' });
    const prompt = calls[0].stdinData ?? calls[0].args[calls[0].args.length - 1];
    expect(prompt).toContain('把这件事查清楚');
  });
});

describe('链式转发：外部 → 其他成员', () => {
  const roster = () => [
    { id: 'm1', group_id: 'g1', agent_id: 'eng', display_name: 'Lead Engineer', runtime: 'claude-code', external_config: JSON.stringify({ workingDir: '/srv/app' }), role_description: '', position: 0 },
    { id: 'm2', group_id: 'g1', agent_id: 'intel', display_name: '情报调研', runtime: 'openclaw', external_config: null, role_description: '', position: 1 },
  ];

  function forwardingEngine() {
    const engine = makeEngine();
    engine.db.getGroupMessages = () => [];
    engine.sendToAgent = vi.fn(async () => 777);
    return engine;
  }

  it('**外部成员 @ 别人时，那个人真的被叫起来**', async () => {
    const engine = forwardingEngine();
    const members = roster();
    const { runner } = fakeRunner({ ok: true, finalText: '@情报调研 帮我查一下这个库的许可证' });

    await runExternal(engine, members[0], runner, { allMembers: members });

    expect(engine.sendToAgent, '外部成员的 @ 只是文本，没有人被叫起来').toHaveBeenCalled();
    const [, , nextAgentId, forwarded, senderName, nextDepth] = engine.sendToAgent.mock.calls[0];
    expect(nextAgentId).toBe('intel');
    expect(forwarded).toContain('许可证');
    expect(senderName).toBe('Lead Engineer');
    expect(nextDepth, '深度没加一，链式转发的上限就失效了').toBe(1);
  });

  it('不转给自己', async () => {
    const engine = forwardingEngine();
    const members = roster();
    const { runner } = fakeRunner({ ok: true, finalText: '@Lead Engineer 自言自语' });
    await runExternal(engine, members[0], runner, { allMembers: members });
    expect(engine.sendToAgent).not.toHaveBeenCalled();
  });

  it('没有 @ 就不转发', async () => {
    const engine = forwardingEngine();
    const members = roster();
    const { runner } = fakeRunner({ ok: true, finalText: '做完了，没什么要问的' });
    await runExternal(engine, members[0], runner, { allMembers: members });
    expect(engine.sendToAgent).not.toHaveBeenCalled();
  });

  it('失败的那一轮不转发——半截结果不该继续往下传', async () => {
    const engine = forwardingEngine();
    const members = roster();
    const { runner } = fakeRunner({ ok: false, errorDetail: 'timeout' });
    await runExternal(engine, members[0], runner, { allMembers: members });
    expect(engine.sendToAgent).not.toHaveBeenCalled();
  });
});

/**
 * P1a：外部成员的运行交给运行协调器。这里钉住迁移后新增的义务，
 * 行为本身（帧、落库、续话、转发）由上面那些迁移前就有的用例守着。
 */
describe('外部成员经运行协调器', () => {
  /** 真的 Claude Code 适配器 + 由用例手动驱动的脚本化进程。 */
  function manualAdapter() {
    const h = harness({ executorOptions: { closeOnTerminate: false } });
    h.deps.fs = sharedFs;
    return { h, adapter: createClaudeCodeAdapter(h.deps) };
  }

  it('会话键按 (群, 成员)，终态后写结束标记；result 的整轮用量按确定性 id 记一次；工具调用与结果成组落库', async () => {
    const engine = makeEngine();
    const { h, adapter } = manualAdapter();
    const running = runExternal(engine, member(), adapter);
    const proc = await h.exec.next();
    proc.line({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 'sid-1' });
    proc.line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'a.ts' } }] }, session_id: 'sid-1' });
    proc.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'body' }] }] }, session_id: 'sid-1' });
    proc.line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }] }, session_id: 'sid-1' });
    const result = { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sid-1', uuid: 'res-1', total_cost_usd: 0.01, usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } };
    // 同一个 result 重放两次：用量只能记一次。
    proc.line(result);
    proc.line(result);
    proc.close(0);
    await running;

    const store: MemoryRunStore = engine.runStore;
    expect(store.calls[0]).toBe('ensure:room:g1:member:m1');
    expect(store.calls.at(-1)).toBe('ended:room:g1:member:m1:complete');
    expect(store.usage).toHaveLength(1);
    expect(store.usage[0]).toMatchObject({
      callId: 'claude-code:sid-1:res-1', source: 'claude-code', agentId: 'ext:claude-code:lead-engineer', scope: 'run',
      inputTokens: 12, outputTokens: 3, cacheReadTokens: 100, cacheWriteTokens: 7, costUsd: 0.01, model: 'claude-sonnet-5',
    });
    expect(store.toolCallBatches.map((batch) => batch.map((c) => [c.callId, c.name, c.output, c.status]))).toEqual([
      [['toolu_1', 'Read', 'body', 'completed']],
    ]);
    expect(engine.db.setGroupMessageRunMarker).toHaveBeenCalledWith(101, expect.stringMatching(/^run-/));
    // 运行时 home 按 (群, 成员) 稳定
    expect(proc.spec.args.join(' ')).not.toContain('--append-system-prompt-file');
    expect([...sharedFs.dirs].some((dir) => dir === homeFor('claude-code', { kind: 'room-member', groupId: 'g1', memberId: 'm1', agentId: 'lead-engineer' }))).toBe(true);
  });

  it('群聊停止经协调器中止外部成员：进程组被停下，等 close 才收尾，会话记成 cancelled，消息写明原因', async () => {
    const engine = makeEngine();
    engine.db.setExternalSession('g1', 'm1', 'uuid-1');
    const { h, adapter } = manualAdapter();
    const running = runExternal(engine, member(), adapter);
    const proc = await h.exec.next();
    proc.line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '做到一半' } }, session_id: 'uuid-1' });
    const coordinator = engine.runCoordinator as RunCoordinator;
    expect(coordinator.getActiveRun('room:g1:member:m1')?.agentId).toBe('ext:claude-code:lead-engineer');

    const aborting = coordinator.abortTopic('room:g1', 'user_stop');
    await new Promise((resolve) => setImmediate(resolve));
    expect(proc.terminateCalls, '中止没有停进程组').toBeGreaterThan(0);
    proc.close(null, 'SIGINT');
    const results = await aborting;
    await running;
    expect(results).toMatchObject([{ aborted: true, synced: true, ignored: false }]);
    expect(engine.db.getExternalSessionRow('g1', 'm1').status).toBe('cancelled');
    const [, content] = (engine.db.updateGroupMessage as any).mock.calls.at(-1);
    expect(content).toBe('Lead Engineer 执行失败（aborted）');
    expect(engine.emitted.filter((e: Emitted) => e.event === 'typing_done')).toHaveLength(1);
  });
});

