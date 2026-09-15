/**
 * 终端的 WebSocket 通道（`/ws/terminal`）。骨架：实现由 P6 终端分支补齐。
 */
import type { IncomingMessage, Server } from 'http';

import type { TerminalService } from './terminal-service';

export const TERMINAL_WS_PATH = '/ws/terminal';

export type TerminalWsOptions<TIdentity> = {
  terminal: TerminalService;
  authenticate: (req: IncomingMessage) => TIdentity | null;
  isHostAllowed: (req: IncomingMessage) => boolean;
};

export function attachTerminalWebSocketServer<TIdentity>(_server: Server, _options: TerminalWsOptions<TIdentity>) {
  return { close: async (): Promise<void> => {} };
}
