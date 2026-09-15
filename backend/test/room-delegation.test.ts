/**
 * 群级异步委派（P3 任务 11）：A 回复里 `/delegate @B 任务` → B 在后台做（不 @ A）→ 结果作为 A 的自主后续一跳交还；
 * 认领 / 确认 / 释放（目标不在线时释放、上线后再投）、重启恢复（B 没做完按失败交还）、委派行不参与 @ 路由、发起人授权照判。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../src/core/db/db';
import { createHandoffStore } from '../src/collab/rooms/handoff-store';
import { createRoomAccess } from '../src/collab/rooms/room-access';
import { createRoomDelegation } from '../src/collab/rooms/room-delegation';
import { createRoomMessageStore } from '../src/collab/rooms/room-message-store';
import { createRoomOrchestrator, parseDelegations, type ExecuteTurnInput } from '../src/collab/rooms/room-orchestrator';
import { createRoomPolicyStore } from '../src/collab/rooms/room-policy';
import { createRoomQueueStore } from '../src/collab/rooms/room-queue';

let home: string;
let previousHome: string | undefined;
let db: DB;

beforeAll(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-room-deleg-'));
  process.env.HOME = home;
  db = new DB();
});

afterAll(() => {
  process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function setup(groupId: string, options: { memberAgents?: Set<string> } = {}) {
  db.saveGroupChat({ id: groupId, name: groupId, max_chain_depth: 4 });
  for (const [index, agent] of ['alpha', 'beta'].entries()) {
    db.saveGroupMember({ id: `${groupId}-${agent}`, group_id: groupId, agent_id: agent, display_name: agent[0].toUpperCase() + agent.slice(1), position: index });
  }
  const conn = db.connection();
  const policies = createRoomPolicyStore(conn);
  const messages = createRoomMessageStore(conn);
  const memberAgents = options.memberAgents ?? new Set(['alpha', 'beta']);
  const identities: Record<number, any> = { 1: { userId: 1, username: 'owner', role: 'admin', implicit: false, mustChangePassword: false }, 2: { userId: 2, username: 'member', role: 'member', implicit: false, mustChangePassword: false } };
  const access = createRoomAccess({
    access: { isAdmin: (i: any) => i.role !== 'member', canAccessRoom: () => true, canManageRoom: (i: any) => i.role !== 'member', canAccessAgent: (i: any, a: string) => i.role !== 'member' || memberAgents.has(a) },
    identityForUser: (id) => identities[id] ?? null, loginEnabled: () => true, policies,
  });
  const online = new Set([`${groupId}-alpha`, `${groupId}-beta`]);
  const turns: Array<{ member: string; kind: string; trigger: string; replyId: number }> = [];
  let script: (input: ExecuteTurnInput) => string = () => 'ok';
  const ref: { delegation: any } = { delegation: null };
  const orchestrator = createRoomOrchestrator({
    db, members: (id) => db.getGroupMembers(id), policies, access, messages, queueStore: createRoomQueueStore(conn), handoffs: createHandoffStore(conn),
    executor: {
      executeTurn: async (input) => {
        const text = script(input);
        const replyId = db.saveGroupMessage({ group_id: input.groupId, sender_type: 'agent', sender_id: input.member.agent_id, sender_name: input.member.display_name, content: text });
        input.onReplyCreated(replyId);
        turns.push({ member: input.member.agent_id, kind: input.payload.kind, trigger: input.payload.triggerText, replyId });
        return { status: 'completed', messageId: replyId, text };
      },
    },
    summary: { beforeInvocation: async () => {}, afterMessage: () => {}, invalidate: () => {} },
    isMemberOnline: (member) => online.has(member.id),
    emitMessage: () => {},
    publish: () => {},
    createDelegation: (input) => { ref.delegation.create(input); },
    onDelegationTaskFinished: (id, result) => ref.delegation.onTaskFinished(id, result),
    log: () => {},
  });
  const delegation = createRoomDelegation({ conn, members: (id) => db.getGroupMembers(id), orchestrator: () => orchestrator, resultText: (id) => String(id ? db.getGroupMessageById(id)?.content ?? '' : ''), publish: () => {}, log: () => {} });
  ref.delegation = delegation;
  const settle = async () => {
    for (let i = 0; i < 100; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (orchestrator.busyMembers(groupId).length === 0) return;
    }
  };
  const owner = { actor: { kind: 'user' as const, userId: 1, username: 'owner', role: 'admin' as const, implicit: false }, identity: identities[1] };
  const member = { actor: { kind: 'user' as const, userId: 2, username: 'member', role: 'member' as const, implicit: false }, identity: identities[2] };
  return { orchestrator, delegation, turns, settle, online, owner, member, setScript: (next: typeof script) => { script = next; } };
}

describe('委派行解析', () => {
  it('只认单独一行、@ 的是别的成员、任务非空', () => {
    const agents = [{ participantId: 'a', displayName: 'Alpha', kind: 'agent' as const }, { participantId: 'b', displayName: 'Beta', kind: 'agent' as const }];
    const text = '先说明一下\n/delegate @Beta 查一下三家供应商报价\n/delegate @Alpha 自己委派给自己\n/delegate @Beta\n行内 /delegate @Beta 不算';
    expect(parseDelegations(text, agents, 'a').map((d) => [d.participant.displayName, d.task])).toEqual([['Beta', '查一下三家供应商报价']]);
  });
});

describe('委派 → 后台执行 → 结果作为自主后续一跳交还', () => {
  it('B 收到任务（不因委派行被 @ 叫起第二次），做完后 A 以 delegation_result 继续', async () => {
    const h = setup('g-deleg');
    h.setScript((input) => {
      if (input.member.agent_id === 'alpha' && input.payload.kind === 'human') return '我先安排一下\n/delegate @Beta 查报价';
      if (input.member.agent_id === 'beta') return '报价：A 10 元，B 12 元';
      return '根据报价选 A';
    });
    h.orchestrator.ingestHumanMessage({ groupId: 'g-deleg', ...h.owner, content: '@Alpha 采购' });
    await h.settle();
    expect(h.turns.map((t) => [t.member, t.kind])).toEqual([['alpha', 'human']]);
    h.delegation.tick();
    await h.settle();
    expect(h.turns.map((t) => [t.member, t.kind])).toEqual([['alpha', 'human'], ['beta', 'delegation_task'], ['alpha', 'delegation_result']]);
    expect(h.turns[1].trigger).toBe('查报价');
    expect(h.turns[2].trigger).toContain('A 10 元');
    expect(h.delegation.list('g-deleg')[0]).toMatchObject({ status: 'completed' });
  });

  it('目标不在线：释放认领，上线后下一轮再投', async () => {
    const h = setup('g-deleg-offline');
    h.setScript((input) => (input.member.agent_id === 'alpha' && input.payload.kind === 'human' ? '/delegate @Beta 做' : 'done'));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-deleg-offline', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    h.online.delete('g-deleg-offline-beta');
    h.delegation.tick();
    await h.settle();
    expect(h.delegation.list('g-deleg-offline')[0]).toMatchObject({ status: 'queued', lastError: 'target Agent is not connected' });
    h.online.add('g-deleg-offline-beta');
    h.delegation.tick();
    await h.settle();
    expect(h.turns.map((t) => t.kind)).toEqual(['human', 'delegation_task', 'delegation_result']);
  });

  it('重启时 B 还没做完：不重跑，按失败交还给 A', async () => {
    const h = setup('g-deleg-restart');
    h.setScript((input) => (input.member.agent_id === 'alpha' && input.payload.kind === 'human' ? '/delegate @Beta 长任务' : '收到失败说明'));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-deleg-restart', ...h.owner, content: '@Alpha 开始' });
    await h.settle();
    const [row] = h.delegation.list('g-deleg-restart');
    db.connection().prepare("UPDATE room_delegations SET status = 'running' WHERE id = ?").run(row.id);
    h.delegation.recoverOnBoot();
    h.delegation.tick();
    await h.settle();
    expect(h.turns.map((t) => [t.member, t.kind])).toEqual([['alpha', 'human'], ['alpha', 'delegation_result']]);
    expect(h.turns[1].trigger).toContain('interrupted by restart');
  });

  it('发起人叫不起 B：不建委派', async () => {
    const h = setup('g-deleg-acl', { memberAgents: new Set(['alpha']) });
    h.setScript((input) => (input.member.agent_id === 'alpha' ? '/delegate @Beta 做' : 'x'));
    h.orchestrator.ingestHumanMessage({ groupId: 'g-deleg-acl', ...h.member, content: '@Alpha 开始' });
    await h.settle();
    expect(h.delegation.list('g-deleg-acl')).toEqual([]);
  });
});
