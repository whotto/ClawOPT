/**
 * 每会话 / 每群成员的运行时目录与回收（参考实现从不回收，spec 04 §2.4 末尾）。
 *
 * 目录：`<数据目录>/runtime/<runtime>/<hash>`，hash = sha256(归属)。每个目录里有一个
 * `.clawopt-home.json` 标记（运行时、归属、创建与最后使用时间）。**回收只删带标记的目录**，
 * 且删之前确认它是 root 下的真实子目录（不是软链、realpath 不逃出 root）。
 *
 * 两条回收路径：
 * - 归属被删（会话删了、成员移出群、群删了）→ `releaseOwner` 立刻删；
 * - 定期清扫：归属已不存在的、或超过 N 天没用过的（N 在界面上可调，0 = 不按空闲回收）。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { canonicalJson } from '../../core/http';
import { readPrivateText, writePrivateText } from '../platform-store';

export type RuntimeHomeOwner =
  | { kind: 'session'; sessionId: string }
  | { kind: 'room-member'; groupId: string; memberId: string; agentId?: string }
  | { kind: 'workflow-node'; workflowId: string; nodeId: string };

export interface RuntimeHomeRecord {
  runtime: string;
  hash: string;
  owner: RuntimeHomeOwner;
  createdAt: string;
  lastUsedAt: string;
}

export interface RuntimeHomesSettings {
  /** 超过这么多天没用过就回收；0 表示只在归属被删时回收。 */
  idleDays: number;
}

export const DEFAULT_RUNTIME_HOMES_SETTINGS: RuntimeHomesSettings = { idleDays: 30 };
export const MARKER_FILE = '.clawopt-home.json';
/** `<数据目录>/runtime/` 下不是运行时目录的名字。 */
const RESERVED_NAMES = new Set(['proxy-targets', 'venvs', 'homes-tmp']);
const RUNTIME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function ownerMatches(a: RuntimeHomeOwner, b: Partial<RuntimeHomeOwner> & { kind: RuntimeHomeOwner['kind'] }): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'session') return (b as any).sessionId === undefined || a.sessionId === (b as any).sessionId;
  if (a.kind === 'room-member') {
    return a.groupId === (b as any).groupId && ((b as any).memberId === undefined || a.memberId === (b as any).memberId);
  }
  return a.workflowId === (b as any).workflowId && ((b as any).nodeId === undefined || a.nodeId === (b as any).nodeId);
}

export class RuntimeHomes {
  private readonly settingsFile: string;

  constructor(private readonly root: string, private readonly now: () => number = Date.now) {
    this.settingsFile = path.join(root, 'homes-settings.json');
  }

  settings(): RuntimeHomesSettings {
    try {
      const parsed = JSON.parse(readPrivateText(this.settingsFile) ?? 'null');
      const idleDays = Number(parsed?.idleDays);
      if (Number.isFinite(idleDays) && idleDays >= 0) return { idleDays: Math.min(3650, Math.floor(idleDays)) };
    } catch {
      // 坏文件按默认值处理，下次保存覆盖。
    }
    return { ...DEFAULT_RUNTIME_HOMES_SETTINGS };
  }

  saveSettings(next: RuntimeHomesSettings): RuntimeHomesSettings {
    const idleDays = Math.max(0, Math.min(3650, Math.floor(Number(next.idleDays))));
    if (!Number.isFinite(idleDays)) throw new Error('idleDays must be a number');
    writePrivateText(this.settingsFile, `${JSON.stringify({ idleDays })}\n`);
    return { idleDays };
  }

  /** 拿（必要时创建）某个归属在某个运行时下的目录，并记一次使用。适配器准备运行时调用。 */
  ensureHome(runtime: string, owner: RuntimeHomeOwner): string {
    if (!RUNTIME_ID.test(runtime) || RESERVED_NAMES.has(runtime)) throw new Error(`invalid runtime id for home: ${runtime}`);
    const hash = crypto.createHash('sha256').update(canonicalJson(owner)).digest('hex').slice(0, 24);
    const dir = path.join(this.root, runtime, hash);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const marker = path.join(dir, MARKER_FILE);
    const existing = this.readMarker(dir);
    const nowIso = new Date(this.now()).toISOString();
    const record: RuntimeHomeRecord = { runtime, hash, owner, createdAt: existing?.createdAt ?? nowIso, lastUsedAt: nowIso };
    writePrivateText(marker, `${JSON.stringify(record)}\n`);
    return dir;
  }

  private readMarker(dir: string): RuntimeHomeRecord | null {
    try {
      const parsed = JSON.parse(readPrivateText(path.join(dir, MARKER_FILE)) ?? 'null');
      if (parsed && typeof parsed.runtime === 'string' && parsed.owner && typeof parsed.owner.kind === 'string') return parsed;
    } catch {
      // 标记坏了：当作不是我们的目录，不碰。
    }
    return null;
  }

  list(): Array<RuntimeHomeRecord & { path: string }> {
    const out: Array<RuntimeHomeRecord & { path: string }> = [];
    let runtimes: fs.Dirent[] = [];
    try {
      runtimes = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const runtimeDir of runtimes) {
      if (!runtimeDir.isDirectory() || RESERVED_NAMES.has(runtimeDir.name) || !RUNTIME_ID.test(runtimeDir.name)) continue;
      let homes: fs.Dirent[] = [];
      try {
        homes = fs.readdirSync(path.join(this.root, runtimeDir.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const home of homes) {
        if (!home.isDirectory()) continue;
        const dir = path.join(this.root, runtimeDir.name, home.name);
        const record = this.readMarker(dir);
        if (record && record.runtime === runtimeDir.name) out.push({ ...record, path: dir });
      }
    }
    return out;
  }

  private remove(dir: string): boolean {
    const root = fs.realpathSync(this.root);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const real = fs.realpathSync(dir);
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 2) return false;
    fs.rmSync(real, { recursive: true, force: true });
    return true;
  }

  /** 归属被删时调用：删掉它在所有运行时下的目录。`memberId` / `sessionId` 省略 = 这个群 / 这类归属的全部。 */
  releaseOwner(owner: Partial<RuntimeHomeOwner> & { kind: RuntimeHomeOwner['kind'] }): number {
    let removed = 0;
    for (const home of this.list()) {
      if (ownerMatches(home.owner, owner) && this.remove(home.path)) removed += 1;
    }
    return removed;
  }

  sweep(ownerExists: (owner: RuntimeHomeOwner) => boolean, settings: RuntimeHomesSettings = this.settings()): Array<{ runtime: string; hash: string; reason: 'orphaned' | 'idle' }> {
    const removed: Array<{ runtime: string; hash: string; reason: 'orphaned' | 'idle' }> = [];
    const idleMs = settings.idleDays * 24 * 60 * 60 * 1000;
    for (const home of this.list()) {
      let reason: 'orphaned' | 'idle' | null = null;
      let exists = true;
      try {
        exists = ownerExists(home.owner);
      } catch {
        exists = true; // 判不了归属就当它还在：宁可留着，不误删。
      }
      if (!exists) reason = 'orphaned';
      else if (idleMs > 0 && this.now() - Date.parse(home.lastUsedAt) > idleMs) reason = 'idle';
      if (reason && this.remove(home.path)) removed.push({ runtime: home.runtime, hash: home.hash, reason });
    }
    return removed;
  }
}
