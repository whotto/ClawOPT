/**
 * 群里「谁能做什么」的判定（spec 02 F5，映射到 ClawOPT 的用户 ↔ Agent 授权）。
 *
 * | 能力 | 谁 |
 * |---|---|
 * | 管理房间（策略、成员、工作区、清空 / 删除、摘要编辑、澄清答复、继续交接、邀请码、配对审批） | admin 及以上；房间归属人；群里每个本机 Agent 都授权给自己的 member（`canManageRoom`） |
 * | 看 / 发消息 / @ Agent | 看得见群（`canAccessRoom`）；访客限自己那个群 |
 * | `@all` | admin 及以上，或房间归属人（访客永远不行） |
 * | 叫起某个 Agent（每一跳） | 发起人授权里有它（本机 Agent 按 `groupMemberAccessAgentId`）；远程 Agent 对看得见群的人都可叫起 |
 * | 答复工具审批 | Agent 的主人：本机 Agent → 房间归属人（没有归属人时 admin 及以上）；远程 Agent → 配对它的人 |
 * | 撤回排队中的消息 | 发这条消息的人（账号用户按身份，访客按能力令牌） |
 *
 * 访客没有自己的授权：他们发起的链按「签发邀请码的人」的授权判（委托）。
 * 登录关闭时的隐式主人只在登录仍关闭时有效——登录打开后，记在消息上的隐式发起人不再叫起任何人（向安全的方向失败）。
 */
import { groupMemberAccessAgentId, type RequestIdentity, type ResourceAccess } from '../../core/auth';
import type { GroupMemberRow } from '../../core/db';
import type { RoomActor, RoomOriginator, RoomPolicyStore } from './room-policy';

export const RELAY_RUNTIME_ID = 'relay';

export type RoomMemberOwner =
  | { kind: 'room' }
  | { kind: 'user'; userId: number }
  | { kind: 'guest'; guestId: string };

export type RoomAccessDeps = {
  access: Pick<ResourceAccess, 'isAdmin' | 'canAccessRoom' | 'canManageRoom' | 'canAccessAgent'>;
  /** 按用户 id 重建身份（停用 / 不存在 → null）。 */
  identityForUser: (userId: number) => RequestIdentity | null;
  loginEnabled: () => boolean;
  policies: Pick<RoomPolicyStore, 'get'>;
};

export function isRelayMember(member: Pick<GroupMemberRow, 'runtime'>): boolean {
  return member.runtime === RELAY_RUNTIME_ID;
}

export function memberOwner(member: GroupMemberRow & { owner_kind?: string | null; owner_user_id?: number | null; owner_guest_id?: string | null }): RoomMemberOwner {
  if (member.owner_kind === 'user' && typeof member.owner_user_id === 'number') return { kind: 'user', userId: member.owner_user_id };
  if (member.owner_kind === 'guest' && typeof member.owner_guest_id === 'string') return { kind: 'guest', guestId: member.owner_guest_id };
  return { kind: 'room' };
}

const IMPLICIT_IDENTITY: RequestIdentity = { userId: null, username: null, role: 'super_admin', implicit: true, mustChangePassword: false };

export function createRoomAccess(deps: RoomAccessDeps) {
  const { access, policies } = deps;

  function actorFromIdentity(identity: RequestIdentity): RoomActor {
    return { kind: 'user', userId: identity.userId, username: identity.username, role: identity.role, implicit: identity.implicit };
  }

  function isOwner(identity: RequestIdentity, groupId: string): boolean {
    if (!access.canAccessRoom(identity, groupId)) return false;
    const policy = policies.get(groupId);
    if (!policy) return false;
    if (identity.implicit) return true;
    if (policy.ownerUserId === null) return access.isAdmin(identity);
    return identity.userId === policy.ownerUserId;
  }

  function isManager(identity: RequestIdentity, groupId: string): boolean {
    if (!access.canAccessRoom(identity, groupId)) return false;
    return access.isAdmin(identity) || isOwner(identity, groupId) || access.canManageRoom(identity, groupId);
  }

  function canMentionAll(actor: RoomActor, groupId: string, identity: RequestIdentity | null): boolean {
    if (actor.kind === 'guest' || !identity) return false;
    return access.isAdmin(identity) || isOwner(identity, groupId);
  }

  /** 发起人的身份（叫起判定用）；没有权威时返回 null（谁也叫不起）。 */
  function originatorIdentity(originator: RoomOriginator): RequestIdentity | null {
    if (originator.kind === 'system') return null;
    const implicit = originator.kind === 'user' ? originator.implicit : originator.delegatedImplicit;
    const userId = originator.kind === 'user' ? originator.userId : originator.delegatedUserId;
    if (implicit || userId === null) return deps.loginEnabled() ? null : IMPLICIT_IDENTITY;
    return deps.identityForUser(userId);
  }

  /** 这个发起人能不能叫起这个成员（每一跳都判，含交接链）。 */
  function originatorCanWake(originator: RoomOriginator, member: GroupMemberRow): boolean {
    const identity = originatorIdentity(originator);
    if (!identity) return false;
    if (isRelayMember(member)) return true;
    return access.canAccessAgent(identity, groupMemberAccessAgentId(member));
  }

  /** 审批只给 Agent 的主人。 */
  function isAgentOwner(actor: RoomActor, identity: RequestIdentity | null, groupId: string, member: GroupMemberRow): boolean {
    const owner = memberOwner(member);
    if (owner.kind === 'guest') return actor.kind === 'guest' && actor.guestId === owner.guestId;
    if (actor.kind !== 'user' || !identity) return false;
    if (owner.kind === 'user') return identity.userId === owner.userId;
    return isOwner(identity, groupId);
  }

  /** 非主人安全提示：请求人（发起人）不是这个 Agent 的主人时注入。 */
  function originatorIsAgentOwner(originator: RoomOriginator, groupId: string, member: GroupMemberRow): boolean {
    const owner = memberOwner(member);
    if (originator.kind === 'system') return true;
    if (owner.kind === 'guest') return originator.kind === 'guest' && originator.guestId === owner.guestId;
    if (originator.kind !== 'user') return false;
    if (owner.kind === 'user') return originator.userId === owner.userId;
    if (originator.implicit) return !deps.loginEnabled();
    const policy = policies.get(groupId);
    if (!policy) return false;
    if (policy.ownerUserId === null) {
      const identity = originator.userId === null ? null : deps.identityForUser(originator.userId);
      return !!identity && access.isAdmin(identity);
    }
    return originator.userId === policy.ownerUserId;
  }

  /** 成员主人的描述 id（安全提示里「主人」一栏）。 */
  function ownerLabel(groupId: string, member: GroupMemberRow): string {
    const owner = memberOwner(member);
    if (owner.kind === 'user') return `user:${owner.userId}`;
    if (owner.kind === 'guest') return `guest:${owner.guestId}`;
    const policy = policies.get(groupId);
    return policy?.ownerUserId ? `user:${policy.ownerUserId}` : 'room-admins';
  }

  return { actorFromIdentity, isOwner, isManager, canMentionAll, originatorIdentity, originatorCanWake, isAgentOwner, originatorIsAgentOwner, ownerLabel };
}

export type RoomAccess = ReturnType<typeof createRoomAccess>;
