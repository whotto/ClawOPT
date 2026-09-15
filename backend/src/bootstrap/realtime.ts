/**
 * 把实时 WebSocket 通道装到 HTTP 服务上：鉴权、Host 白名单、主题授权、接回快照、交互答复，
 * 全部从应用上下文里取——ws-server.ts 本身不认识任何业务表。
 */
import type { Server } from 'http';

import { attachRealtimeWebSocketServer, parseRealtimeTopic } from '../core/realtime';
import { externalSenderId } from '../collab/rooms';
import type { AppContext } from './context';
import { isRequestHostAllowed } from './host-check';

export function attachRealtimeServer(server: Server, ctx: AppContext) {
  const { db, runCoordinator } = ctx;

  /** 主题指向的东西必须存在：会话、群、或名册里（单聊会话 / 群成员 / 角色）出现过的 Agent。 */
  const authorizeTopic = (topic: string): boolean => {
    const parsed = parseRealtimeTopic(topic);
    if (!parsed) return false;
    switch (parsed.kind) {
      case 'session':
        return !!db.getSession(parsed.id) || runCoordinator.isBusy(parsed.id);
      case 'room':
        return !!db.getGroupChat(parsed.id);
      case 'agent':
        return !!db.getSessionByAgentId(parsed.id)
          || db.getCharacters().some((character) => character.agentId === parsed.id)
          || db.listAllGroupMembers().some((member) => (
            member.agent_id === parsed.id || externalSenderId(member.runtime || 'openclaw', member.agent_id) === parsed.id
          ));
    }
  };

  const snapshotTopic = (topic: string) => {
    const parsed = parseRealtimeTopic(topic);
    if (parsed?.kind === 'session') return { sessions: [runCoordinator.snapshot(parsed.id)] };
    return { sessions: runCoordinator.snapshotTopic(topic) };
  };

  return attachRealtimeWebSocketServer(server, {
    hub: ctx.realtime,
    authenticate: (req) => ctx.auth.isAuthenticatedHeaders(req.headers),
    isHostAllowed: (req) => isRequestHostAllowed(req.headers, ctx.configManager.getConfig().allowedHosts),
    authorizeTopic,
    snapshotTopic,
    respondInteraction: (sessionKey, id, response) => runCoordinator.respondInteraction(sessionKey, id, response),
  });
}
