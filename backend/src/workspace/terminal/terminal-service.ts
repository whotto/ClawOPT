/**
 * Web 终端（P6，spec 07 §2.7 超越版）。
 *
 * 参考实现的缺陷与这里的做法：
 * - 断线即杀全部 shell → 会话与连接解耦：断开只「脱离」，按用户归属保留，重连后凭新票据接回；
 * - 输出缓冲按块数封顶 → 按字节封顶的环形缓冲（`ring-buffer.ts`），接回按字节偏移补差额；
 * - 客户端指定 shell 路径 → 服务端白名单（`shells.ts`），客户端只给 id；
 * - 没有空闲超时 → 脱离后空闲超时回收（默认 30 分钟），每用户会话数上限；
 * - 没有审计 → 生命周期审计（`terminal-audit.ts`），不记按键；
 * - 令牌放在 WS URL → 一次性票据（`tickets.ts`），见 `terminal-ws.ts`。
 *
 * 子进程：关闭 / 回收时对**整棵进程树**（进程组 + 按 ppid 快照的全部后代，Linux 再加同会话 id）发 SIGHUP，宽限后 SIGKILL——
 * 作业控制下的后台任务在别的进程组、还可能忽略 SIGHUP，只杀进程组收不干净（`process-tree.ts`）。环境从子进程环境白名单起步（与外部运行时同一份名单），`CLAWOPT_*` 一律不给。
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DB } from '../../core/db';
import { CHILD_ENV_ALLOWLIST, type HostCapabilities } from '../../runtime';
import { killProcessTree } from './process-tree';
import { loadNodePty, probePty, type PtyLoadResult, type PtyModule, type PtyProcess } from './pty-loader';
import { ByteRingBuffer, DEFAULT_TERMINAL_BUFFER_BYTES, type RingBufferSlice } from './ring-buffer';
import { detectShells, resolveShell, type TerminalShell } from './shells';
import { createTerminalAudit, type TerminalAuditRow } from './terminal-audit';
import { TerminalTicketStore, type TicketOwner } from './tickets';

export const DEFAULT_TERMINAL_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS_PER_USER = 8;
export const TERMINAL_KILL_GRACE_MS = 2000;
/** 退出后的会话再留这么久：重连的人还能看到最后的输出与退出码。 */
export const EXITED_SESSION_RETENTION_MS = 60_000;

export type TerminalIdentity = { userId: number | null; username: string | null; role: string };

export type TerminalServiceDeps = {
  db: DB;
  /** 主机能力探测（node-pty 能否加载；闸门与界面提示的来源）。 */
  hostCapabilities: () => Promise<HostCapabilities>;
  /** 以下只给测试注入。 */
  loadPty?: () => PtyLoadResult;
  shells?: () => TerminalShell[];
  idleMs?: number;
  bufferBytes?: number;
  maxSessionsPerUser?: number;
  ticketTtlMs?: number;
  killGraceMs?: number;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
};

export type TerminalAvailability = { available: boolean; reasonCode: string | null; detail?: string | null; platform?: string };

export class TerminalError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = 'TerminalError';
  }
}

export type TerminalSessionView = {
  id: string;
  shellId: string;
  shellLabel: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActivityAt: number;
  attached: number;
  exited: boolean;
  exitCode: number | null;
  bufferStart: number;
  bufferEnd: number;
};

export type TerminalListener = {
  onOutput: (data: string, end: number) => void;
  onExit: (exitCode: number | null, signal: number | null) => void;
};

type Session = {
  id: string;
  owner: TicketOwner & { userId: number | null };
  shell: TerminalShell;
  cwd: string;
  cols: number;
  rows: number;
  pty: PtyProcess;
  buffer: ByteRingBuffer;
  listeners: Set<TerminalListener>;
  createdAt: number;
  lastActivityAt: number;
  idleTimer: NodeJS.Timeout | null;
  exited: boolean;
  exitCode: number | null;
  signal: number | null;
  closing: boolean;
};

export function terminalOwner(identity: TerminalIdentity): TicketOwner & { userId: number | null } {
  return { userKey: identity.userId === null ? 'implicit' : `user:${identity.userId}`, username: identity.username, userId: identity.userId };
}

const clampDimension = (value: unknown, fallback: number, max: number) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 2 ? Math.min(number, max) : fallback;
};

/** 伪终端的环境：白名单起步（外部运行时同一份名单），不给任何 `CLAWOPT_*`。 */
export function buildTerminalEnv(source: NodeJS.ProcessEnv, shell: TerminalShell): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || key.startsWith('CLAWOPT_')) continue;
    if (CHILD_ENV_ALLOWLIST.includes(key) || key.startsWith('LC_')) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.SHELL = shell.path;
  if (!env.HOME) env.HOME = os.homedir();
  if (!env.PATH) env.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

export function createTerminalService(deps: TerminalServiceDeps) {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? DEFAULT_TERMINAL_IDLE_MS;
  const maxSessions = deps.maxSessionsPerUser ?? DEFAULT_MAX_SESSIONS_PER_USER;
  const killGraceMs = deps.killGraceMs ?? TERMINAL_KILL_GRACE_MS;
  const tickets = new TerminalTicketStore({ ttlMs: deps.ticketTtlMs, now });
  const audit = createTerminalAudit(deps.db.connection(), now);
  const sessions = new Map<string, Session>();
  const killTimers = new Set<NodeJS.Timeout>();
  let shellCache: TerminalShell[] | null = null;
  let loaded: PtyLoadResult | null = null;
  let availabilityCache: TerminalAvailability | null = null;
  let stopped = false;

  const shells = (): TerminalShell[] => {
    if (!shellCache) shellCache = deps.shells ? deps.shells() : detectShells({ loginShell: (deps.env ?? process.env).SHELL });
    return shellCache;
  };

  const pty = (): PtyLoadResult => {
    if (!loaded) loaded = (deps.loadPty ?? loadNodePty)();
    return loaded;
  };

  async function availability(refresh = false): Promise<TerminalAvailability> {
    if (availabilityCache && !refresh) return availabilityCache;
    if (refresh) {
      loaded = null;
      shellCache = null;
    }
    if (process.platform === 'win32') {
      availabilityCache = { available: false, reasonCode: 'host.platformUnsupported', detail: null, platform: process.platform };
      return availabilityCache;
    }
    const result = pty();
    if (!result.ok) {
      availabilityCache = { available: false, reasonCode: result.reasonCode, detail: result.detail, platform: process.platform };
      return availabilityCache;
    }
    const probeShell = shells().find((shell) => shell.id === 'sh') ?? shells()[0];
    if (!probeShell) {
      availabilityCache = { available: false, reasonCode: 'host.platformUnsupported', detail: 'no shell found', platform: process.platform };
      return availabilityCache;
    }
    const probe = await probePty(result.pty, probeShell.path);
    availabilityCache = probe.ok
      ? { available: true, reasonCode: null, detail: null, platform: process.platform }
      : { available: false, reasonCode: 'host.nodePtyBroken', detail: probe.detail, platform: process.platform };
    return availabilityCache;
  }

  const view = (session: Session): TerminalSessionView => ({
    id: session.id,
    shellId: session.shell.id,
    shellLabel: session.shell.label,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    attached: session.listeners.size,
    exited: session.exited,
    exitCode: session.exitCode,
    bufferStart: session.buffer.start,
    bufferEnd: session.buffer.end,
  });

  const auditFor = (session: Session, event: Parameters<typeof audit.record>[0]['event'], detail?: string | null) => {
    audit.record({ userId: session.owner.userId, username: session.owner.username, sessionId: session.id, event, shell: session.shell.id, detail });
  };

  /** 按归属取会话：不存在与不是你的对调用方不可区分（都是 notFound）。 */
  function requireOwned(identity: TerminalIdentity, sessionId: unknown): Session {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!session || session.owner.userKey !== terminalOwner(identity).userKey) throw new TerminalError('terminal.sessionNotFound', 404);
    return session;
  }

  function killSessionTree(session: Session): void {
    killProcessTree(session.pty.pid, {
      graceMs: killGraceMs,
      onTimer: (timer) => {
        killTimers.add(timer);
        setTimeout(() => killTimers.delete(timer), killGraceMs + 50).unref?.();
      },
    });
  }

  function forget(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    sessions.delete(session.id);
  }

  function scheduleIdle(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    if (session.listeners.size > 0 || stopped) return;
    if (session.exited) {
      session.idleTimer = setTimeout(() => forget(session), Math.min(idleMs, EXITED_SESSION_RETENTION_MS));
    } else {
      session.idleTimer = setTimeout(() => {
        auditFor(session, 'kill_idle', `idle ${Math.round(idleMs / 1000)}s`);
        session.closing = true;
        killSessionTree(session);
        forget(session);
      }, idleMs);
    }
    session.idleTimer.unref?.();
  }

  async function createSession(identity: TerminalIdentity, input: { shellId?: unknown; cols?: unknown; rows?: unknown; cwd?: unknown }): Promise<TerminalSessionView> {
    if (stopped) throw new TerminalError('terminal.stopped', 503);
    const available = await availability();
    if (!available.available) throw new TerminalError(available.reasonCode ?? 'host.nodePtyMissing', 503);
    const owner = terminalOwner(identity);
    const shell = resolveShell(shells(), input.shellId);
    if (!shell) {
      audit.record({ userId: owner.userId, username: owner.username, event: 'reject', detail: 'shell not in allowlist' });
      throw new TerminalError('terminal.shellNotAllowed');
    }
    const owned = [...sessions.values()].filter((session) => session.owner.userKey === owner.userKey && !session.exited);
    if (owned.length >= maxSessions) throw new TerminalError('terminal.tooManySessions', 429);
    let cwd = os.homedir();
    if (input.cwd !== undefined && input.cwd !== null && input.cwd !== '') {
      if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || /[\0\r\n]/.test(input.cwd)) throw new TerminalError('terminal.invalidCwd');
      try {
        if (!fs.statSync(input.cwd).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new TerminalError('terminal.invalidCwd');
      }
      cwd = input.cwd;
    }
    const cols = clampDimension(input.cols, 80, 500);
    const rows = clampDimension(input.rows, 24, 200);
    const loadedPty = pty() as { ok: true; pty: PtyModule };
    let child: PtyProcess;
    try {
      // 登录 shell（-l）读用户自己的 profile；参数固定，不接受客户端参数。
      child = loadedPty.pty.spawn(shell.path, shell.id === 'sh' ? [] : ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: buildTerminalEnv(deps.env ?? process.env, shell) });
    } catch (error) {
      throw new TerminalError('host.nodePtyBroken', 503);
    }
    const session: Session = {
      id: randomUUID(),
      owner,
      shell,
      cwd,
      cols,
      rows,
      pty: child,
      buffer: new ByteRingBuffer(deps.bufferBytes ?? DEFAULT_TERMINAL_BUFFER_BYTES),
      listeners: new Set(),
      createdAt: now(),
      lastActivityAt: now(),
      idleTimer: null,
      exited: false,
      exitCode: null,
      signal: null,
      closing: false,
    };
    sessions.set(session.id, session);
    child.onData((data) => {
      const end = session.buffer.append(data);
      session.lastActivityAt = now();
      for (const listener of [...session.listeners]) {
        try { listener.onOutput(data, end); } catch { /* 单个连接出错不影响别的 */ }
      }
    });
    child.onExit(({ exitCode, signal }) => {
      session.exited = true;
      session.exitCode = typeof exitCode === 'number' ? exitCode : null;
      session.signal = typeof signal === 'number' && signal > 0 ? signal : null;
      if (!session.closing) auditFor(session, 'exit', `code ${session.exitCode ?? '-'}${session.signal ? ` signal ${session.signal}` : ''}`);
      for (const listener of [...session.listeners]) {
        try { listener.onExit(session.exitCode, session.signal); } catch { /* ignore */ }
      }
      if (session.closing) forget(session);
      else scheduleIdle(session);
    });
    auditFor(session, 'open', `${cols}x${rows}`);
    scheduleIdle(session);
    return view(session);
  }

  function attach(identity: TerminalIdentity, sessionId: unknown, sinceOffset: unknown, listener: TerminalListener): { session: TerminalSessionView; replay: RingBufferSlice; detach: () => void } {
    const session = requireOwned(identity, sessionId);
    // 快照与订阅在同一个同步段里完成：快照之后的输出一定会进这个监听，不重不漏。
    const replay = session.buffer.sliceFrom(typeof sinceOffset === 'number' ? sinceOffset : null);
    session.listeners.add(listener);
    scheduleIdle(session);
    auditFor(session, 'attach', replay.truncated ? 'replay truncated' : null);
    let detached = false;
    return {
      session: view(session),
      replay,
      detach: () => {
        if (detached) return;
        detached = true;
        if (!session.listeners.delete(listener)) return;
        if (sessions.get(session.id) !== session) return;
        auditFor(session, 'detach');
        scheduleIdle(session);
      },
    };
  }

  function input(identity: TerminalIdentity, sessionId: unknown, data: unknown): void {
    const session = requireOwned(identity, sessionId);
    if (session.exited) throw new TerminalError('terminal.sessionExited', 409);
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new TerminalError('terminal.invalidInput');
    session.lastActivityAt = now();
    session.pty.write(data);
  }

  function resize(identity: TerminalIdentity, sessionId: unknown, cols: unknown, rows: unknown): void {
    const session = requireOwned(identity, sessionId);
    if (session.exited) return;
    session.cols = clampDimension(cols, session.cols, 500);
    session.rows = clampDimension(rows, session.rows, 200);
    try { session.pty.resize(session.cols, session.rows); } catch { /* 刚退出 */ }
  }

  function close(identity: TerminalIdentity, sessionId: unknown): void {
    const session = requireOwned(identity, sessionId);
    auditFor(session, 'close');
    session.closing = true;
    if (session.exited) {
      forget(session);
      return;
    }
    killSessionTree(session);
    forget(session);
    for (const listener of [...session.listeners]) {
      try { listener.onExit(null, null); } catch { /* ignore */ }
    }
  }

  return {
    availability,
    shells: () => shells().map(({ id, label, isDefault }) => ({ id, label, isDefault })),
    issueTicket(identity: TerminalIdentity): { ticket: string; expiresAt: number } {
      const owner = terminalOwner(identity);
      const issued = tickets.issue(owner);
      audit.record({ userId: owner.userId, username: owner.username, event: 'ticket_issued' });
      return issued;
    },
    /** 核对并作废票据；失败记一条 reject。 */
    consumeTicket(identity: TerminalIdentity, ticket: unknown): boolean {
      const owner = terminalOwner(identity);
      const ok = tickets.consume(ticket, owner) !== null;
      if (!ok) audit.record({ userId: owner.userId, username: owner.username, event: 'reject', detail: 'invalid ticket' });
      return ok;
    },
    recordReject(identity: TerminalIdentity | null, detail: string): void {
      audit.record({ userId: identity?.userId ?? null, username: identity?.username ?? null, event: 'reject', detail });
    },
    listSessions(identity: TerminalIdentity): TerminalSessionView[] {
      const key = terminalOwner(identity).userKey;
      return [...sessions.values()].filter((session) => session.owner.userKey === key).map(view);
    },
    createSession,
    attach,
    input,
    resize,
    close,
    audit: (limit?: number): TerminalAuditRow[] => audit.list(limit),
    /** 测试与性能页用：当前全部会话的子进程 pid。 */
    sessionPids: (): number[] => [...sessions.values()].filter((session) => !session.exited).map((session) => session.pty.pid),
    async stop(): Promise<void> {
      stopped = true;
      for (const session of [...sessions.values()]) {
        if (!session.exited) {
          auditFor(session, 'kill_shutdown');
          session.closing = true;
          killProcessTree(session.pty.pid, { graceMs: 0 });
        }
        forget(session);
      }
      for (const timer of killTimers) clearTimeout(timer);
      killTimers.clear();
    },
  };
}

export type TerminalService = ReturnType<typeof createTerminalService>;
