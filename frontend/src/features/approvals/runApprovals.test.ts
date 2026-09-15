import { describe, expect, it } from 'vitest';
import { approvalContext, approvalsForContext, approvalsOutsideContext, orderedChoices, type RunApproval } from './runApprovals';

const approval = (sessionKey: string, surface = 'chat'): RunApproval => ({
  id: `a-${sessionKey}`, sessionKey, runId: 'r', agentId: 'x', agentName: 'Pi', surface, runtime: 'pi', title: 'rm?', description: null, command: null, choices: ['deny', 'once'], remainingTimeoutMs: 1000,
});

describe('运行审批', () => {
  it('会话键归到对话：单聊、群成员、其他表面', () => {
    expect(approvalContext(approval('s-pi'))).toEqual({ kind: 'chat', id: 's-pi' });
    expect(approvalContext(approval('room:g1:member:m1', 'room'))).toEqual({ kind: 'group', id: 'g1' });
    expect(approvalContext(approval('workflow:abc', 'workflow'))).toEqual({ kind: 'other' });
  });

  it('聊天页只显示当前对话的；待办中心显示其余的', () => {
    const list = [approval('s-pi'), approval('room:g1:member:m1', 'room'), approval('s-other')];
    expect(approvalsForContext(list, { kind: 'chat', id: 's-pi' }).map((a) => a.sessionKey)).toEqual(['s-pi']);
    expect(approvalsForContext(list, { kind: 'group', id: 'g1' }).map((a) => a.sessionKey)).toEqual(['room:g1:member:m1']);
    expect(approvalsOutsideContext(list, { kind: 'chat', id: 's-pi' }).map((a) => a.sessionKey)).toEqual(['room:g1:member:m1', 's-other']);
    expect(approvalsOutsideContext(list, null)).toHaveLength(3);
    expect(approvalsForContext(list, null)).toEqual([]);
  });

  it('按钮顺序固定，只给请求里有的', () => {
    expect(orderedChoices(['deny', 'always', 'once'])).toEqual(['once', 'always', 'deny']);
  });
});
