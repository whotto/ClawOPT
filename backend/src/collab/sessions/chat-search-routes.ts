import { getRequestIdentity, type ResourceAccess } from '../../core/auth';
import type { DB } from '../../core/db';
import type { RouteApp } from '../../core/http';
import { listRecentChatSessions, searchChats } from './chat-search';
import type { SessionManager } from './session-manager';

export type ChatSearchRoutesDeps = {
  db: Pick<DB, 'connection'>;
  sessionManager: Pick<SessionManager, 'getAllSessions'>;
  access: Pick<ResourceAccess, 'canAccessChatSession'>;
};

/**
 * Ctrl/Cmd+K 全局搜索。登录即可调用，**按用户过滤在排序查询里面**：
 * 先按 `canAccessChatSession`（与会话列表、history、`/ws` 同一判据）算出看得见的会话 id，
 * 再把这份 id 交给 SQL——看不见的会话不会出现在结果里，也不会占掉 limit。
 * `q` 为空时回最近会话（按最后一条消息排序）。
 */
export function registerChatSearchRoutes(app: RouteApp, ctx: ChatSearchRoutesDeps): void {
  app.get('/api/search/chat', (req, res) => {
    try {
      const identity = getRequestIdentity(req);
      const visibleSessionIds = ctx.sessionManager.getAllSessions()
        .filter((session) => ctx.access.canAccessChatSession(identity, session.id))
        .map((session) => session.id);
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      if (!query.trim()) {
        res.json({ success: true, mode: 'recent', terms: [], results: listRecentChatSessions(ctx.db.connection(), { visibleSessionIds, limit: req.query.limit }) });
        return;
      }
      const { terms, results } = searchChats(ctx.db.connection(), { query, visibleSessionIds, limit: req.query.limit });
      res.json({ success: true, mode: 'search', terms, results });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Search failed' });
    }
  });
}
