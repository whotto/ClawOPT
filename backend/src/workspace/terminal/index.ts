export {
  DEFAULT_MAX_SESSIONS_PER_USER,
  DEFAULT_TERMINAL_IDLE_MS,
  TerminalError,
  buildTerminalEnv,
  createTerminalService,
  terminalOwner,
} from './terminal-service';
export type {
  TerminalAvailability,
  TerminalIdentity,
  TerminalListener,
  TerminalService,
  TerminalServiceDeps,
  TerminalSessionView,
} from './terminal-service';
export { TERMINAL_AUTH_TIMEOUT_MS, TERMINAL_WS_PATH, attachTerminalWebSocketServer, urlCarriesCredential } from './terminal-ws';
export type { TerminalWsOptions } from './terminal-ws';
export { registerTerminalRoutes } from './terminal-routes';
export type { TerminalRoutesDeps } from './terminal-routes';
export { ByteRingBuffer, DEFAULT_TERMINAL_BUFFER_BYTES } from './ring-buffer';
export { detectShells, resolveShell } from './shells';
export type { TerminalShell } from './shells';
export { TerminalTicketStore, TERMINAL_TICKET_TTL_MS } from './tickets';
