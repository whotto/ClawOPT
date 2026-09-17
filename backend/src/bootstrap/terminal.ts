/**
 * 把 Web 终端的 WebSocket（`/ws/terminal`）装到 HTTP 服务上：Host 白名单与登录身份与 /ws 同一套判据，
 * 票据与会话在 `workspace/terminal` 里。
 */
import type { Server } from 'http';

import { attachTerminalWebSocketServer } from '../workspace';
import type { AppContext } from './context';
import { isRequestHostAllowed } from './host-check';

export function attachTerminalServer(server: Server, ctx: AppContext) {
  return attachTerminalWebSocketServer(server, {
    terminal: ctx.terminal,
    authenticate: (req) => ctx.auth.authenticateHeaders(req.headers),
    isHostAllowed: (req) => isRequestHostAllowed(req.headers, ctx.configManager.getConfig().allowedHosts),
  });
}
