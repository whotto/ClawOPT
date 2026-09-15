/**
 * Web 终端（P6，spec 07 §2.7 超越版）：node-pty 会话、按字节环形缓冲、断线接回、一次性票据、服务端 shell 白名单、空闲回收、审计。
 *
 * 骨架：实现由 P6 终端分支补齐。
 */
import type { DB } from '../../core/db';
import type { HostCapabilities } from '../../runtime';

export type TerminalServiceDeps = {
  db: DB;
  /** 主机能力探测（node-pty 能否加载；闸门与界面提示的来源）。 */
  hostCapabilities: () => Promise<HostCapabilities>;
};

export type TerminalAvailability = { available: boolean; reasonCode: string | null };

export function createTerminalService(_deps: TerminalServiceDeps) {
  return {
    async availability(): Promise<TerminalAvailability> {
      return { available: false, reasonCode: 'host.nodePtyMissing' };
    },
    async stop(): Promise<void> {},
  };
}

export type TerminalService = ReturnType<typeof createTerminalService>;
