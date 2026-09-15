/**
 * 编排器与交接续跑（P3 任务 1–3）：真 DB（一次性 HOME）+ 假执行器。
 *
 * 守：服务端签发深度、深度上限记停止链（每个目标一条）、一跳「继续」经 outbox / inbox 完成且只多给一跳、
 * `outcome_unknown` 终态不重试、重启恢复、发起人授权逐跳生效（v1.9 已知风险）、撤回。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../src/core/db/db';
import { createHandoffDispatcher, RELAY_OUTCOME_UNKNOWN_CODE } from '../src/collab/rooms/handoff-dispatcher';
import { createHandoffStore } from '../src/collab/rooms/handoff-store';
import { createRoomAccess } from '../src/collab/rooms/room-access';
import { createRoomMessageStore } from '../src/collab/rooms/room-message-store';
import { createRoomOrchestrator, type ExecuteTurnInput, type MemberTurnResult } from '../src/collab/rooms/room-orchestrator';
import { createRoomPolicyStore } from '../src/collab/rooms/room-policy';
import { createRoomQueueStore } from '../src/collab/rooms/room-queue';

let home: string;
let previousHome: string | undefined;
let db: DB;

beforeAll(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-room-orch-'));
  process.env.HOME = home;
  db = new DB();
});

afterAll(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

type Script = (input: ExecuteTurnInput) => Promise<{ text?: string; status?: MemberTurnResult['status']; errorCode?: string }> | { text?: string; status?: MemberTurnResult['status']; errorCode?: string };

function setup(groupId: string, options: { maxDepth?: number; memberAgents?: string[] | Set<string> } = {}) {
  db.saveGroupChat({ id: groupId, name: groupId, max_chain_depth: options.maxDepth ?? 2 });
  for (const [index, agent] of ['alpha', 'beta', 'gamma'].entries()) {
    db.saveGroupMember({ id: `${groupId}-${agent}`, group_id: groupId, agent_id: agent, display_name: agent[0].toUpperCase() + agent.slice(1), position: index });
  }
  const conn = db.connection();
  const policies = createRoomPolicyStore(conn);
  const messages = createRoomMessageStore(conn);
  const queueStore = createRoomQueueStore(conn);
  const handoffs = createHandoffStore(conn);
  const memberAgents = options.memberAgents instanceof Set ? options.memberAgents : new Set(options.memberAgents ?? ['alpha']);
  const identities: Record<number, any> = {
    1: { userId: 1, username: 'owner', role: 'admin', implicit: false, mustChangePassword: false },
    2: { userId: 2, username: 'member', role: 'member', implicit: false, mustChangePassword: false },
  };
  const access = createRoomAccess({
    access: {
      isAdmin: (identity: any) => identity.role !== 'member',
      canAccessRoom: () => true,
      canManageRoom: (identity: any) => identity.role !== 'member',
      canAccessAgent: (identity: any, agentId: string) => identity.role !== 'member' || memberAgents.has(agentId),
    },
    identityForUser: (userId) => identities[userId] ?? null,
    loginEnabled: () => true,
    policies,
  });
  const turns: Array<{ member: string; kind: string; depth: number; originator: any; replyId: number | null }> = [];
  const frames: Array<{ type: string; data: any }> = [];
  let script: Script = () => ({ text: 'ok' });
  const dispatcherRef: { current: any } = { current: null };
  const orchestrator = createRoomOrchestrator({
    db,
    members: (id) => db.getGroupMembers(id),
    policies,
    access,
    messages,
    queueStore,
    handoffs,
    executor: {
      executeTurn: async (input) => {
        const result = await script(input);
        const replyId = result.status && result.status !== 'completed' && !result.text
          ? null
          : db.saveGroupMessage({ group_id: input.groupId, sender_type: 'agent', sender_id: input.member.agent_id, sender_name: input.member.display_name, content: result.text ?? '' });
        if (replyId !== null) input.onReplyCreated(replyId);
        turns.push({ member: input.member.agent_id, kind: input.payload.kind, depth: input.payload.depth, originator: input.payload.originator, replyId });
        return { status: result.status ?? 'completed', messageId: replyId, text: result.text ?? '', errorCode: result.errorCode, error: result.errorCode };
      },
    },
    summary: { beforeInvocation: async () => {}, afterMessage: () => {}, invalidate: () => {} },
    isMemberOnline: () => true,
    emitMessage: () => {},
    publish: (_group, frame) => frames.push(frame),
    onContinuationFinished: (attemptId, result) => dispatcherRef.current.onTurnFinished(attemptId, result),
    log: () => {},
  });
  const dispatcher = createHandoffDispatcher({
    db, members: (id) => db.getGroupMembers(id), policies, access, messages, store: handoffs, orchestrator: () => orchestrator,
    isMemberOnline: () => true, publish: (_group, frame) => frames.push(frame), log: () => {},
  });
  dispatcherRef.current = dispatcher;
  const settle = async () => {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (orchestrator.busyMembers(groupId).length === 0) return;
    }
  };
  const owner = { actor: { kind: 'user' as const, userId: 1, username: 'owner', role: 'admin' as const, implicit: false }, identity: identities[1] };
  const member = { actor: { kind: 'user' as const, userId: 2, username: 'member', role: 'member' as const, implicit: false }, identity: identities[2] };
  return { orchestrator, dispatcher, handoffs, policies, queueStore, messages, turns, frames, settle, owner, member, setScript: (next: Script) => { script = next; } };
}

describe('深度由服务端签发，到上限记停止链', () => {
  it('Alpha → Beta → Gamma：第二跳回复深度 2 = 上限，点到的目标记停止链，不再叫起', async () => {
    const h = setup('g-depth', { maxDepth: 2 });
    h.setScript((input) => {
      if (input.member.agent_id === 'alpha') return { text: '做完了 @Beta 请继续' };
      if (input.member.agent_id === 'beta') return { text: '收到 @Gamma 你来收尾' };
      return { text: 'gamma done' };
    });
    h.orchestrator.ingestHumanMessage({ groupId: 'g-depth', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    expect(h.turns.map((t) => [t.member, t.depth])).toEqual([['alpha', 0], ['beta', 1]]);
    const betaReply = h.turns[1].replyId!;
    expect(h.messages.getMeta(betaReply)).toMatchObject({ mentionDepth: 2, structuredMentions: [{ type: 'agent', participantId: 'g-depth-gamma', displayName: 'Gamma' }] });
    const chains = h.dispatcher.list('g-depth');
    expect(chains).toHaveLength(1);
    expect(chains[0]).toMatchObject({ targetName: 'Gamma', currentDepth: 2, maxDepth: 2, status: 'stopped', actionable: true });
  });

  it('一条回复点了两个目标，每个目标各一条停止链', async () => {
    const h = setup('g-multi', { maxDepth: 1 });
    h.setScript((input) => (input.member.agent_id === 'alpha' ? { text: '@Beta 和 @Gamma 分别看看' } : { text: 'x' }));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-multi', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    expect(h.dispatcher.list('g-multi').map((c) => c.targetName).sort()).toEqual(['Beta', 'Gamma']);
  });

  it('继续：只多给一跳；成功后链 resumed，重复点 replay；目标的回复回到停下时的深度', async () => {
    const h = setup('g-continue', { maxDepth: 2 });
    h.setScript((input) => {
      if (input.member.agent_id === 'alpha') return { text: '@Beta 请继续' };
      if (input.member.agent_id === 'beta') return { text: '@Gamma 你来' };
      return { text: '@Alpha 回给你' };
    });
    h.orchestrator.ingestHumanMessage({ groupId: 'g-continue', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [chain] = h.dispatcher.list('g-continue');
    const started = h.dispatcher.continueChain('g-continue', chain.chainId, h.owner.identity);
    expect(started.status).toBe('continuing');
    expect(h.dispatcher.continueChain('g-continue', chain.chainId, h.owner.identity).status).toBe('alreadyClaimed');
    expect(h.dispatcher.tick()).toBe(true);
    await h.settle();
    const gammaTurn = h.turns.find((t) => t.member === 'gamma')!;
    expect(gammaTurn).toMatchObject({ kind: 'continuation', depth: 1 });
    expect(h.messages.getMeta(gammaTurn.replyId!)!.mentionDepth).toBe(2);
    // Gamma 的回复又 @ 了 Alpha：深度仍是上限 → 新的停止链，不自动叫起（「继续」只给一跳）。
    expect(h.turns.filter((t) => t.member === 'alpha')).toHaveLength(1);
    const after = h.dispatcher.list('g-continue');
    expect(after.find((c) => c.chainId === chain.chainId)).toMatchObject({ status: 'resumed', continueUsed: true, actionable: false });
    expect(after.some((c) => c.targetName === 'Alpha' && c.status === 'stopped')).toBe(true);
    expect(h.dispatcher.continueChain('g-continue', chain.chainId, h.owner.identity).status).toBe('replay');
  });

  it('策略改了（深度上限变化）或目标成员配置改了：停止链不可继续', async () => {
    const h = setup('g-policy', { maxDepth: 1 });
    h.setScript((input) => (input.member.agent_id === 'alpha' ? { text: '@Beta 看看' } : { text: 'x' }));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-policy', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [chain] = h.dispatcher.list('g-policy');
    h.policies.update('g-policy', { handoffMaxDepth: 3 });
    expect(h.dispatcher.list('g-policy')[0].actionable).toBe(false);
    expect(() => h.dispatcher.continueChain('g-policy', chain.chainId, h.owner.identity)).toThrow(/NotActionable|handoffNotActionable/);
    h.policies.update('g-policy', { handoffMaxDepth: 1 });
    expect(h.dispatcher.list('g-policy')[0].actionable).toBe(true);
    db.saveGroupMember({ id: 'g-policy-beta', group_id: 'g-policy', agent_id: 'beta', display_name: 'Beta 改名', position: 1 });
    expect(h.dispatcher.list('g-policy')[0].actionable).toBe(false);
  });

  it('远程通道断在没有权威结果时：outcome_unknown 终态，继续回 409，不自动重试', async () => {
    const h = setup('g-unknown', { maxDepth: 1 });
    h.setScript((input) => (input.member.agent_id === 'alpha'
      ? { text: '@Beta 远程做' }
      : { status: 'failed', errorCode: RELAY_OUTCOME_UNKNOWN_CODE }));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-unknown', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [chain] = h.dispatcher.list('g-unknown');
    h.dispatcher.continueChain('g-unknown', chain.chainId, h.owner.identity);
    h.dispatcher.tick();
    await h.settle();
    expect(h.dispatcher.list('g-unknown')[0]).toMatchObject({ status: 'outcome_unknown', continueUsed: true, actionable: false });
    expect(() => h.dispatcher.continueChain('g-unknown', chain.chainId, h.owner.identity)).toThrow(/OutcomeUnknown/);
    expect(h.dispatcher.tick()).toBe(false);
  });

  it('续跑那一跳报错：链回到 stopped / continue_failed，可以再点继续', async () => {
    const h = setup('g-retry', { maxDepth: 1 });
    let betaCalls = 0;
    h.setScript((input) => {
      if (input.member.agent_id === 'alpha') return { text: '@Beta 做' };
      betaCalls += 1;
      return betaCalls === 1 ? { status: 'failed', text: '❌ Beta 响应失败: boom' } : { text: 'beta ok' };
    });
    h.orchestrator.ingestHumanMessage({ groupId: 'g-retry', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [chain] = h.dispatcher.list('g-retry');
    h.dispatcher.continueChain('g-retry', chain.chainId, h.owner.identity);
    h.dispatcher.tick();
    await h.settle();
    expect(h.dispatcher.list('g-retry')[0]).toMatchObject({ status: 'stopped', stopReason: 'continue_failed', actionable: true });
    h.dispatcher.continueChain('g-retry', chain.chainId, h.owner.identity);
    h.dispatcher.tick();
    await h.settle();
    expect(h.dispatcher.list('g-retry')[0]).toMatchObject({ status: 'resumed' });
  });
});

describe('重启恢复', () => {
  it('远程执行中的续跑 → outcome_unknown；认领后租约过期没派发的 → 失败且可再继续', () => {
    const h = setup('g-restart', { maxDepth: 1 });
    const alphaMsg = db.saveGroupMessage({ group_id: 'g-restart', sender_type: 'agent', sender_id: 'alpha', sender_name: 'Alpha', content: '@Beta @Gamma' });
    const members = db.getGroupMembers('g-restart');
    const snapshot = (id: string) => JSON.stringify({ id, agentId: members.find((m) => m.id === id)!.agent_id, name: members.find((m) => m.id === id)!.display_name, runtime: 'openclaw', config: null, role: '' });
    for (const target of ['g-restart-beta', 'g-restart-gamma']) {
      h.handoffs.recordStoppedChain({ groupId: 'g-restart', sourceMessageId: alphaMsg, currentDepth: 1, maxDepth: 1, unlimited: false, targetMemberId: target, targetSnapshot: snapshot(target), originator: { kind: 'user', userId: 1, username: 'owner', implicit: false } });
    }
    const [beta, gamma] = h.dispatcher.list('g-restart');
    h.dispatcher.continueChain('g-restart', beta.chainId, h.owner.identity);
    const claimed = h.handoffs.claimNextOutbox()!;
    h.handoffs.admit({ attemptId: claimed.attempt.attempt_id, targetMemberId: claimed.attempt.target_member_id, payload: claimed.payload, currentSnapshot: claimed.attempt.target_snapshot, executor: 'remote' });
    h.handoffs.recordDelivery(claimed.attempt.attempt_id, claimed.attempt.target_member_id);
    h.handoffs.acceptAttempt(claimed.attempt.attempt_id);
    h.handoffs.markInvocationStarted(claimed.attempt.attempt_id);

    h.dispatcher.continueChain('g-restart', gamma.chainId, h.owner.identity);
    db.connection().prepare('UPDATE room_handoff_attempts SET lease_until = 1 WHERE chain_id = ?').run(gamma.chainId);

    const stats = h.handoffs.recoverOnBoot();
    expect(stats.unknown).toBe(1);
    const after = Object.fromEntries(h.dispatcher.list('g-restart').map((c) => [c.targetName, c]));
    expect(after.Beta).toMatchObject({ status: 'outcome_unknown' });
    expect(after.Gamma).toMatchObject({ status: 'stopped', stopReason: 'continue_failed', actionable: true });
  });

  it('载荷被改过（摘要对不上）入 inbox 时拒收，链回到可继续', async () => {
    const h = setup('g-digest', { maxDepth: 1 });
    h.setScript((input) => (input.member.agent_id === 'alpha' ? { text: '@Beta 做' } : { text: 'x' }));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-digest', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [chain] = h.dispatcher.list('g-digest');
    h.dispatcher.continueChain('g-digest', chain.chainId, h.owner.identity);
    db.connection().prepare("UPDATE room_handoff_outbox SET payload_json = json_set(payload_json, '$.content', '篡改')").run();
    h.dispatcher.tick();
    await h.settle();
    expect(h.turns.filter((t) => t.member === 'beta')).toHaveLength(0);
    expect(h.dispatcher.list('g-digest')[0]).toMatchObject({ status: 'stopped', stopReason: 'continue_failed' });
  });
});

describe('发起人授权沿交接链逐跳生效（修 v1.9 已知风险）', () => {
  it('member 只授权了 Alpha：Alpha 回复里 @Beta 不叫起 Beta，回提示；admin 发起同样的链则照常', async () => {
    const h = setup('g-acl', { maxDepth: 4, memberAgents: ['alpha'] });
    h.setScript((input) => (input.member.agent_id === 'alpha' ? { text: '@Beta 帮我做' } : { text: 'beta done' }));
    const result = h.orchestrator.ingestHumanMessage({ groupId: 'g-acl', ...h.member, content: '@Alpha 开始' });
    expect(result.blocked).toEqual([]);
    await h.settle();
    expect(h.turns.map((t) => t.member)).toEqual(['alpha']);
    expect(h.turns[0].originator).toMatchObject({ kind: 'user', userId: 2 });
    expect(h.frames.some((f) => f.type === 'notice' && f.data.messageCode === 'groups.handoffNotPermitted')).toBe(true);

    h.turns.length = 0;
    h.orchestrator.ingestHumanMessage({ groupId: 'g-acl', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    expect(h.turns.map((t) => t.member)).toEqual(['alpha', 'beta']);
  });

  it('继续：点按钮的人也必须叫得起目标', async () => {
    const h = setup('g-acl-continue', { maxDepth: 1, memberAgents: ['alpha'] });
    h.setScript((input) => (input.member.agent_id === 'alpha' ? { text: '@Beta 做' } : { text: 'x' }));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-acl-continue', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [chain] = h.dispatcher.list('g-acl-continue');
    expect(() => h.dispatcher.continueChain('g-acl-continue', chain.chainId, h.member.identity)).toThrow(/handoffNotPermitted/);
  });

  it('排队期间授权被收回：开跑前再判，行记失败，不叫起', async () => {
    const memberAgents = new Set(['alpha']);
    const h = setup('g-revoke', { maxDepth: 4, memberAgents });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.setScript(async () => { await gate; return { text: 'ok' }; });
    h.orchestrator.ingestHumanMessage({ groupId: 'g-revoke', ...h.member, content: '@Alpha 第一条' });
    const second = h.orchestrator.ingestHumanMessage({ groupId: 'g-revoke', ...h.member, content: '@Alpha 第二条' });
    memberAgents.clear();
    release();
    await h.settle();
    expect(h.turns).toHaveLength(1);
    expect(h.queueStore.rowsForMessage(second.messageId)[0]).toMatchObject({ status: 'failed', last_error: 'groups.mentionNotPermitted' });
  });
});

describe('撤回', () => {
  it('排队中的消息被发送人撤回：消息删除、那个 Agent 不再处理它、摘要失效', async () => {
    const h = setup('g-retract');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.setScript(async () => { await gate; return { text: 'ok' }; });
    h.orchestrator.ingestHumanMessage({ groupId: 'g-retract', ...h.owner, content: '@Alpha 第一条' });
    const second = h.orchestrator.ingestHumanMessage({ groupId: 'g-retract', ...h.owner, content: '@Alpha 第二条' });
    const generation = h.policies.get('g-retract')!.summaryGeneration;
    expect(() => h.orchestrator.retract({ groupId: 'g-retract', messageId: second.messageId, actor: h.member.actor })).toThrow(/Forbidden/);
    expect(h.orchestrator.retract({ groupId: 'g-retract', messageId: second.messageId, actor: h.owner.actor }).status).toBe('retracted');
    expect(db.getGroupMessageById(second.messageId, 'g-retract')).toBeFalsy();
    expect(h.policies.get('g-retract')!.summaryGeneration).toBe(generation + 1);
    release();
    await h.settle();
    expect(h.turns).toHaveLength(1);
    expect(h.frames.some((f) => f.type === 'message_retracted' && f.data.messageId === second.messageId)).toBe(true);
  });

  it('已经开跑的消息不能撤回', async () => {
    const h = setup('g-retract-running');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.setScript(async () => { await gate; return { text: 'ok' }; });
    const first = h.orchestrator.ingestHumanMessage({ groupId: 'g-retract-running', ...h.owner, content: '@Alpha 第一条' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(() => h.orchestrator.retract({ groupId: 'g-retract-running', messageId: first.messageId, actor: h.owner.actor })).toThrow(/NotCancellable/);
    release();
    await h.settle();
  });
});

describe('@all 与结构化 @ 在入口', () => {
  it('member 的 @all（文本或结构化）403；非法结构化 @ 400，都不落库', () => {
    const h = setup('g-entry');
    const before = db.getLatestGroupMessageId('g-entry');
    expect(() => h.orchestrator.ingestHumanMessage({ groupId: 'g-entry', ...h.member, content: '@all 开会' })).toThrow(/allMentionForbidden/);
    expect(() => h.orchestrator.ingestHumanMessage({ groupId: 'g-entry', ...h.member, content: '看看', mentions: [{ type: 'agent', participantId: 'g-entry-alpha', displayName: 'Alpha' }] })).toThrow(/not visible/);
    expect(db.getLatestGroupMessageId('g-entry')).toBe(before);
  });
});
