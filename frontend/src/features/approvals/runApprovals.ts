// 运行审批（后端 GET /api/run-approvals）的纯逻辑：请求属于哪个对话、当前页该显示哪些、按钮顺序。
// 审批来自协调器的审批注册表：Pi、Hermes 这类真审批运行时在单聊 / 群里发起的请求。

export type RunApprovalChoice = 'once' | 'session' | 'always' | 'deny';

export type RunApproval = {
  id: string;
  sessionKey: string;
  runId: string;
  agentId: string;
  agentName: string | null;
  surface: string;
  runtime: string;
  title: string;
  description: string | null;
  command: string | null;
  choices: RunApprovalChoice[];
  remainingTimeoutMs: number | null;
};

export type ApprovalContext = { kind: 'chat'; id: string } | { kind: 'group'; id: string } | { kind: 'other' };

const ROOM_SESSION_KEY = /^room:(.+):member:[^:]+$/;

/** 协调器会话键 → 对话：群成员 `room:<群>:member:<成员>` 归群；`workflow:` 等其他表面不属于任何对话；其余是单聊会话 id。 */
export function approvalContext(approval: Pick<RunApproval, 'sessionKey' | 'surface'>): ApprovalContext {
  const room = ROOM_SESSION_KEY.exec(approval.sessionKey);
  if (room) return { kind: 'group', id: room[1] };
  if (approval.surface === 'chat') return { kind: 'chat', id: approval.sessionKey };
  return { kind: 'other' };
}

export const sameContext = (a: ApprovalContext, b: ApprovalContext | null) => (
  b !== null && a.kind !== 'other' && a.kind === b.kind && (a as { id: string }).id === (b as { id: string }).id
);

/** 聊天页里的审批卡：只要当前对话的。待办中心：除当前对话以外的（当前对话里已经有卡了）。 */
export function approvalsForContext(list: RunApproval[], context: ApprovalContext | null): RunApproval[] {
  return list.filter((approval) => sameContext(approvalContext(approval), context));
}

export function approvalsOutsideContext(list: RunApproval[], context: ApprovalContext | null): RunApproval[] {
  return list.filter((approval) => !sameContext(approvalContext(approval), context));
}

const CHOICE_ORDER: RunApprovalChoice[] = ['once', 'session', 'always', 'deny'];

/** 按钮顺序固定（允许一次在前、拒绝在后），只显示请求里给的选项。 */
export function orderedChoices(choices: RunApprovalChoice[]): RunApprovalChoice[] {
  return CHOICE_ORDER.filter((choice) => choices.includes(choice));
}
