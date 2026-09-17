/**
 * 群里的审批与澄清路由（spec 02 F15）。
 *
 * 待决请求本身在运行协调器的注册表里（按 (会话, Agent) 排队、排到队首才计时、超时即拒绝、运行中止即拒绝、重连按剩余时间）；
 * 这里只决定**谁看得见、谁能答**：
 *
 * - 工具审批 → 只给这个 Agent 的**主人**：本机 Agent 是房间归属人（没有归属人时 admin 及以上），远程 Agent 是配对它的人；
 * - 澄清问题 → 房间管理员；
 * - 访客永远不能答审批（除非审批属于他自己配对的远程 Agent）、不能答澄清。
 *
 * 群成员的协调器会话键是 `room:<群>:member:<成员>`；列表与答复都按它反查成员。
 * 过时的答复（请求已经结束）回 `{ resolved: true, stale: true }`，界面据此收起卡片，不报错。
 */
import type { RequestIdentity } from '../../core/auth';
import type { GroupMemberRow } from '../../core/db';
import type { RunCoordinator } from '../../runtime';
import type { RoomAccess } from './room-access';
import type { RoomActor } from './room-policy';

const ROOM_MEMBER_SESSION = /^room:(.+):member:([^:]+)$/;

export function parseRoomMemberSessionKey(sessionKey: string): { groupId: string; memberId: string } | null {
  const match = ROOM_MEMBER_SESSION.exec(sessionKey);
  return match ? { groupId: match[1], memberId: match[2] } : null;
}

export type RoomInteractionView = {
  kind: 'approval' | 'clarify';
  id: string;
  sessionKey: string;
  memberId: string;
  agentName: string;
  runId: string;
  title: string;
  description: string | null;
  command: string | null;
  question: string | null;
  choices: string[] | null;
  remainingTimeoutMs: number | null;
};

export type RoomInteractionsDeps = {
  coordinator: Pick<RunCoordinator, 'respondInteraction'> & { interactions: Pick<RunCoordinator['interactions'], 'pendingAll'> };
  access: RoomAccess;
  members: (groupId: string) => GroupMemberRow[];
};

export function createRoomInteractions(deps: RoomInteractionsDeps) {
  /** 这个人能不能处理这个请求（审批看主人，澄清看管理员）。 */
  function canHandle(kind: 'approval' | 'clarify', groupId: string, member: GroupMemberRow, actor: RoomActor, identity: RequestIdentity | null): boolean {
    if (kind === 'approval') return deps.access.isAgentOwner(actor, identity, groupId, member);
    return actor.kind === 'user' && !!identity && deps.access.isManager(identity, groupId);
  }

  /** 按会话键判（全局待办中心、`/ws` 的 interaction.respond 用）：非群成员会话返回 null（交给原判据）。 */
  function canHandleSession(sessionKey: string, interactionId: string, identity: RequestIdentity): boolean | null {
    const parsed = parseRoomMemberSessionKey(sessionKey);
    if (!parsed) return null;
    const pending = deps.coordinator.interactions.pendingAll().find((view) => view.id === interactionId && view.sessionKey === sessionKey);
    const member = deps.members(parsed.groupId).find((row) => row.id === parsed.memberId);
    if (!pending || !member) return false;
    return canHandle(pending.kind, parsed.groupId, member, deps.access.actorFromIdentity(identity), identity);
  }

  function list(groupId: string, actor: RoomActor, identity: RequestIdentity | null): RoomInteractionView[] {
    const members = deps.members(groupId);
    return deps.coordinator.interactions.pendingAll()
      .filter((view) => view.activatedAt !== null)
      .flatMap((view) => {
        const parsed = parseRoomMemberSessionKey(view.sessionKey);
        if (!parsed || parsed.groupId !== groupId) return [];
        const member = members.find((row) => row.id === parsed.memberId);
        if (!member || !canHandle(view.kind, groupId, member, actor, identity)) return [];
        const request = view.request as unknown as Record<string, unknown>;
        return [{
          kind: view.kind,
          id: view.id,
          sessionKey: view.sessionKey,
          memberId: member.id,
          agentName: member.display_name,
          runId: view.runId,
          title: typeof request.title === 'string' ? request.title : '',
          description: typeof request.description === 'string' ? request.description : null,
          command: typeof request.command === 'string' ? request.command : null,
          question: typeof request.question === 'string' ? request.question : null,
          choices: Array.isArray(request.choices) ? (request.choices as string[]) : null,
          remainingTimeoutMs: view.remainingTimeoutMs,
        }];
      });
  }

  function respond(groupId: string, interactionId: string, actor: RoomActor, identity: RequestIdentity | null, response: { choice?: string; text?: string }):
    { status: 'resolved' | 'stale' | 'forbidden' | 'notActive' } {
    const pending = deps.coordinator.interactions.pendingAll().find((view) => view.id === interactionId);
    if (!pending) return { status: 'stale' };
    const parsed = parseRoomMemberSessionKey(pending.sessionKey);
    const member = parsed && parsed.groupId === groupId ? deps.members(groupId).find((row) => row.id === parsed.memberId) : undefined;
    if (!member || !canHandle(pending.kind, groupId, member, actor, identity)) return { status: 'forbidden' };
    const result = deps.coordinator.respondInteraction(pending.sessionKey, interactionId, response);
    if (result.resolved) return { status: 'resolved' };
    if (result.error === 'stale') return { status: 'stale' };
    return { status: 'notActive' };
  }

  return { list, respond, canHandleSession };
}

export type RoomInteractions = ReturnType<typeof createRoomInteractions>;
