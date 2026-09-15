/**
 * 把实时 WebSocket 通道装到 HTTP 服务上：鉴权、Host 白名单、主题授权、接回快照、交互答复，
 * 全部从应用上下文里取——ws-server.ts 本身不认识任何业务表。
 */
import type { Server } from 'http';

import { attachRealtimeWebSocketServer, parseRealtimeTopic } from '../core/realtime';
import { externalSenderId, parseExternalSenderId } from '../collab/rooms';
import { chatSessionAccessAgentId, externalRuntimeAgentId, type RequestIdentity } from '../core/auth';
import type { AppContext } from './context';
import { isRequestHostAllowed } from './host-check';

export function attachRealtimeServer(server: Server, ctx: AppContext) {
  const { db, runCoordinator, access } = ctx;

  /**
   * 主题授权 = 资源存在 + 这个身份看得见（P5a 用户 ↔ Agent 授权，判据在 core/auth/resource-access.ts，与 HTTP 路由同一处）：
   * - `session:<key>`：单聊会话 / 群外部成员会话 / 其他协调器会话（工作流节点），按其 Agent 判；
   * - `room:<id>`：admin，或能看群里至少一个 Agent；
   * - `agent:<id>`：名册里（单聊会话 / 群成员 / 角色）出现过，且能看这个 Agent（外部成员 `ext:<运行时>:<id>` 与外部运行时单聊按 `ext:<运行时>` 判）；
 * - `workflow:<id>`：admin，或工作流里每个节点的 Agent 都能看；
 * - `approvals:workflows` / `approvals:runs`：任何已登录用户（事件不带内容，列表经 HTTP 按用户过滤）。
   */
  const canAccessSessionKey = (identity: RequestIdentity, sessionKey: string): boolean => {
    if (access.canAccessRunSession(identity, sessionKey)) return true;
    // 还没有会话行、但协调器里正在跑的（首轮刚提交）：按运行视图里的 Agent 判。
    const active = runCoordinator.getActiveRun(sessionKey);
    return !!active && access.canAccessAgent(identity, active.agentId);
  };

  const authorizeTopic = (topic: string, identity: RequestIdentity): boolean => {
    const parsed = parseRealtimeTopic(topic);
    if (!parsed) return false;
    switch (parsed.kind) {
      case 'session': {
        if (!canAccessSessionKey(identity, parsed.id)) return false;
        // 群成员的会话主题带审批请求的内容（P3）：只给这个 Agent 的主人。管理员经 HTTP 取澄清（不需要订阅会话主题）。
        const roomMember = /^room:(.+):member:[^:]+$/.exec(parsed.id);
        return !roomMember || ctx.roomCollab.members(roomMember[1]).some((member) => (
          `room:${roomMember[1]}:member:${member.id}` === parsed.id && ctx.roomCollab.roomAccess.isAgentOwner(ctx.roomCollab.roomAccess.actorFromIdentity(identity), identity, roomMember[1], member)
        ));
      }
      case 'room':
        return access.canAccessRoom(identity, parsed.id);
      case 'workflow':
        return access.canAccessWorkflow(identity, ctx.automation.workflowAgentIds(parsed.id));
      case 'approvals':
        // 只是「待审批集合变了」的提醒，不带内容；列表本身经 HTTP 按用户过滤。
        return parsed.id === 'workflows' || parsed.id === 'runs';
      case 'agent': {
        // 判定用的 id：外部成员 `ext:<运行时>:<成员>` 与外部运行时单聊都按 `ext:<运行时>` 判（core/auth/agent-ids.ts）。
        const external = parseExternalSenderId(parsed.id);
        const chatSession = db.getSessionByAgentId(parsed.id);
        const agentId = external ? externalRuntimeAgentId(external.runtime) : chatSession ? chatSessionAccessAgentId(chatSession) : parsed.id;
        const known = !!chatSession
          || db.getCharacters().some((character) => character.agentId === parsed.id)
          || db.listAllGroupMembers().some((member) => (
            member.agent_id === parsed.id || externalSenderId(member.runtime || 'openclaw', member.agent_id) === parsed.id
          ));
        return known && access.canAccessAgent(identity, agentId);
      }
    }
  };

  const snapshotTopic = (topic: string) => {
    const parsed = parseRealtimeTopic(topic);
    if (parsed?.kind === 'session') return { sessions: [runCoordinator.snapshot(parsed.id)] };
    if (parsed?.kind === 'workflow') return { workflow: ctx.automation.hub.snapshot(parsed.id) };
    if (parsed?.kind === 'approvals') return {};
    // 房间主题的快照不带待决交互与交互帧：它们只给 Agent 主人 / 管理员（经 HTTP 按身份取，或订阅会话主题）。
    const interactionEvent = /^(approval|clarify)\./;
    return {
      sessions: runCoordinator.snapshotTopic(topic).map((snapshot) => (parsed?.kind === 'room'
        ? { ...snapshot, pendingInteractions: [], replay: snapshot.replay.filter((event) => !interactionEvent.test(event.type)) }
        : snapshot)),
    };
  };

  return attachRealtimeWebSocketServer<RequestIdentity>(server, {
    hub: ctx.realtime,
    authenticate: (req) => ctx.auth.authenticateHeaders(req.headers),
    isHostAllowed: (req) => isRequestHostAllowed(req.headers, ctx.configManager.getConfig().allowedHosts),
    authorizeTopic,
    snapshotTopic,
    // 答复审批 / 澄清等同于在那个会话里操作：先判会话可见。
    respondInteraction: (sessionKey, id, response, identity) => (
      canAccessSessionKey(identity, sessionKey) && ctx.roomCollab.interactions.canHandleSession(sessionKey, id, identity) !== false
        ? runCoordinator.respondInteraction(sessionKey, id, response)
        : { handled: false, resolved: false, error: 'forbidden' }
    ),
  });
}
