/**
 * 写入审批（spec 05 F30 的 OpenClaw 适配版）。
 *
 * ## 为什么要自建
 *
 * Agent 自己改 MEMORY.md / USER.md / SOUL.md、自己建改技能，改的是它**以后每一次对话**的行为。
 * OpenClaw 没有这类写入的暂存层（它的 `skills workshop` 只管经提案工具提交的技能，不管直接写文件），
 * 所以 ClawOPT 在控制面自建一层：打开某个 Agent 的开关后，受守护文件的**外部改动**先暂存、再审批。
 *
 * ## 机制（诚实的边界写在界面帮助文本里）
 *
 * 1. 开启时给受守护文件拍「已批准基线」（内容 + 哈希，存 SQLite）；
 * 2. 文件监听器看到受守护路径变化：内容与基线不同 → 记一条待审记录（基线、提议内容、两者哈希），
 *    然后**把文件还原成基线**——不还原就只是事后审计，不是闸门；
 * 3. 批准：按「解析后的工作区目录」串行；磁盘当前内容必须仍等于记录的基线（否则 409，给出当前内容供重新审阅）；
 *    提议内容与磁盘当前一致 → 识别为空补丁，不写盘只结案；否则经 SafeFileStore 写入并更新基线；
 *    成功以「记录已消失」核实，不信返回值；
 * 4. 拒绝：删记录（文件早已是基线）。
 *
 * 局限：监听与还原之间有一个短窗口（通常 < 1 秒），Agent 在窗口内可能读到自己刚写的内容；
 * 监听器分不清改动来自 Agent 还是有人在终端手改（两者都会被暂存）；ClawOPT 自己的编辑器写入
 * 经 `acknowledgeWrite` 登记，不会被当成外部改动；服务停着的时候发生的改动，下次开启时按「基线已变」提示。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { DB } from '../../core/db';
import type { SafeFileStore } from '../../core/files';
import { readTextFileSafe } from '../../openclaw';
import { ControlInputError } from '../shared/control-http';
import type { EngineRoster } from '../shared/engine-roster';
import { unifiedDiff } from './line-diff';

export const GUARDED_ROOT_FILES = ['MEMORY.md', 'USER.md', 'SOUL.md'] as const;
export const GUARDED_SKILLS_DIR = 'skills';
const MAX_GUARDED_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 500;
const DEBOUNCE_MS = 250;

export type PendingWriteRow = {
  id: string;
  agent_id: string;
  workspace_dir: string;
  rel_path: string;
  base_content: string | null;
  base_hash: string | null;
  proposed_content: string | null;
  proposed_hash: string | null;
  origin: string;
  created_at: number;
  updated_at: number;
};

export type PendingWriteSummary = {
  id: string;
  agentId: string;
  relPath: string;
  action: 'create' | 'update' | 'delete';
  origin: string;
  baseHash: string | null;
  proposedHash: string | null;
  createdAt: number;
  updatedAt: number;
};

export function hashContent(content: string | null): string | null {
  return content === null ? null : crypto.createHash('sha256').update(content).digest('hex');
}

/** 受守护的相对路径：根下三个文件，或 `skills/` 下的文件（不含隐藏段与 `..`）。 */
export function isGuardedPath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join('/');
  if ((GUARDED_ROOT_FILES as readonly string[]).includes(normalized)) return true;
  if (!normalized.startsWith(`${GUARDED_SKILLS_DIR}/`)) return false;
  const segments = normalized.split('/');
  return segments.length >= 2 && segments.every((segment) => segment && segment !== '..' && !segment.startsWith('.'));
}

function actionOf(row: Pick<PendingWriteRow, 'base_content' | 'proposed_content'>): PendingWriteSummary['action'] {
  if (row.base_content === null) return 'create';
  if (row.proposed_content === null) return 'delete';
  return 'update';
}

function summarize(row: PendingWriteRow): PendingWriteSummary {
  return {
    id: row.id,
    agentId: row.agent_id,
    relPath: row.rel_path,
    action: actionOf(row),
    origin: row.origin,
    baseHash: row.base_hash,
    proposedHash: row.proposed_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 读文本文件：不存在 → null；太大、不是普通文件、看起来是二进制 → 抛（调用方跳过这个路径）。 */
function readGuardedFile(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_GUARDED_BYTES) throw new Error('unsupported file');
  const text = readTextFileSafe(filePath);
  if (!text.exists) return null;
  const content = String(text.value);
  if (content.includes('\u0000')) throw new Error('binary file');
  return content;
}

type Watcher = { close: () => void };
export type WatchFactory = (dir: string, onChange: (relPath: string) => void) => Watcher;

const defaultWatchFactory: WatchFactory = (dir, onChange) => {
  const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
    if (filename) onChange(String(filename));
  });
  watcher.on('error', () => undefined);
  return watcher;
};

export type WriteGateDeps = {
  db: DB;
  roster: EngineRoster;
  fileStore: SafeFileStore;
  now?: () => number;
  watch?: WatchFactory;
  log?: (message: string) => void;
};

export function createWriteGateService(deps: WriteGateDeps) {
  const sql = deps.db.connection();
  const now = deps.now ?? Date.now;
  const watchFactory = deps.watch ?? defaultWatchFactory;
  const log = deps.log ?? ((message: string) => console.log(message));
  const watchers = new Map<string, { dir: string; watcher: Watcher; timers: Map<string, NodeJS.Timeout> }>();
  /** ClawOPT 自己即将写出的内容（agentId + relPath → hash）：监听器看到它不算外部改动。 */
  const expectedWrites = new Map<string, string | null>();
  const dirQueues = new Map<string, Promise<unknown>>();

  const key = (agentId: string, relPath: string) => `${agentId}\u0000${relPath}`;

  function isEnabled(agentId: string): boolean {
    const row = sql.prepare('SELECT enabled FROM write_gate_settings WHERE agent_id = ?').get(agentId) as { enabled: number } | undefined;
    return row?.enabled === 1;
  }

  function listSettings(): Array<{ agentId: string; enabled: boolean; pending: number }> {
    const rows = sql.prepare('SELECT agent_id, enabled FROM write_gate_settings ORDER BY agent_id').all() as Array<{ agent_id: string; enabled: number }>;
    const counts = new Map((sql.prepare('SELECT agent_id, COUNT(*) AS n FROM write_gate_pending GROUP BY agent_id').all() as Array<{ agent_id: string; n: number }>).map((row) => [row.agent_id, row.n]));
    return rows.map((row) => ({ agentId: row.agent_id, enabled: row.enabled === 1, pending: counts.get(row.agent_id) ?? 0 }));
  }

  function getBaseline(agentId: string, relPath: string): { content: string | null; hash: string | null } | undefined {
    const row = sql.prepare('SELECT content, hash FROM write_gate_baselines WHERE agent_id = ? AND rel_path = ?').get(agentId, relPath) as { content: string | null; hash: string | null } | undefined;
    return row ?? undefined;
  }

  function setBaseline(agentId: string, relPath: string, content: string | null): void {
    sql.prepare('INSERT INTO write_gate_baselines (agent_id, rel_path, content, hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, rel_path) DO UPDATE SET content = excluded.content, hash = excluded.hash, updated_at = excluded.updated_at')
      .run(agentId, relPath, content, hashContent(content), now());
  }

  function listGuardedFiles(workspaceDir: string): string[] {
    const out: string[] = [...GUARDED_ROOT_FILES];
    const skillsRoot = path.join(workspaceDir, GUARDED_SKILLS_DIR);
    const walk = (dir: string) => {
      if (out.length >= GUARDED_ROOT_FILES.length + MAX_SKILL_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(path.relative(workspaceDir, full).split(path.sep).join('/'));
      }
    };
    walk(skillsRoot);
    return out;
  }

  async function resolveWorkspace(agentId: string): Promise<string> {
    const agent = await deps.roster.get(agentId);
    if (!agent.workspace) throw new ControlInputError('writeGate.noWorkspace', 409);
    try {
      return fs.realpathSync(agent.workspace);
    } catch {
      throw new ControlInputError('writeGate.noWorkspace', 409);
    }
  }

  /** 监听器回调（也是测试的入口）：一个受守护路径变了。 */
  async function handleChange(agentId: string, workspaceDir: string, relPathRaw: string): Promise<'ignored' | 'expected' | 'staged'> {
    const relPath = relPathRaw.split(path.sep).join('/');
    if (!isGuardedPath(relPath) || !isEnabled(agentId)) return 'ignored';
    const filePath = path.join(workspaceDir, relPath);
    let current: string | null;
    try {
      current = readGuardedFile(filePath);
    } catch {
      return 'ignored';
    }
    const currentHash = hashContent(current);
    const writeKey = key(agentId, relPath);
    if (expectedWrites.has(writeKey) && expectedWrites.get(writeKey) === currentHash) {
      expectedWrites.delete(writeKey);
      return 'expected';
    }
    const baseline = getBaseline(agentId, relPath) ?? { content: null, hash: null };
    if (baseline.hash === currentHash) return 'ignored';

    const existing = sql.prepare('SELECT * FROM write_gate_pending WHERE agent_id = ? AND rel_path = ?').get(agentId, relPath) as PendingWriteRow | undefined;
    const ts = now();
    if (existing) {
      // 同一文件在审阅前又被改了：记录跟着最新提议走，基线不变。
      sql.prepare('UPDATE write_gate_pending SET proposed_content = ?, proposed_hash = ?, updated_at = ? WHERE id = ?').run(current, currentHash, ts, existing.id);
    } else {
      sql.prepare('INSERT INTO write_gate_pending (id, agent_id, workspace_dir, rel_path, base_content, base_hash, proposed_content, proposed_hash, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), agentId, workspaceDir, relPath, baseline.content, baseline.hash, current, currentHash, 'external-write', ts, ts);
    }

    // 还原成基线。还原本身也会触发监听事件，登记成「预期写入」避免自我暂存。
    expectedWrites.set(writeKey, baseline.hash);
    try {
      if (baseline.content === null) fs.rmSync(filePath, { force: true });
      else await deps.fileStore.update(filePath, () => ({ next: baseline.content as string }));
    } catch (error) {
      expectedWrites.delete(writeKey);
      log(`[WriteGate] revert failed for ${agentId}:${relPath}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    return 'staged';
  }

  function startWatching(agentId: string, workspaceDir: string): void {
    stopWatching(agentId);
    const timers = new Map<string, NodeJS.Timeout>();
    try {
      const watcher = watchFactory(workspaceDir, (relPath) => {
        const normalized = relPath.split(path.sep).join('/');
        if (!isGuardedPath(normalized)) return;
        clearTimeout(timers.get(normalized));
        timers.set(normalized, setTimeout(() => {
          timers.delete(normalized);
          void handleChange(agentId, workspaceDir, normalized);
        }, DEBOUNCE_MS));
      });
      watchers.set(agentId, { dir: workspaceDir, watcher, timers });
    } catch (error) {
      log(`[WriteGate] watch failed for ${agentId}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }

  function stopWatching(agentId: string): void {
    const entry = watchers.get(agentId);
    if (!entry) return;
    for (const timer of entry.timers.values()) clearTimeout(timer);
    entry.watcher.close();
    watchers.delete(agentId);
  }

  async function setEnabled(agentId: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new ControlInputError('writeGate.invalidToggle');
    if (enabled) {
      const workspaceDir = await resolveWorkspace(agentId);
      const snapshot = sql.transaction(() => {
        sql.prepare('DELETE FROM write_gate_baselines WHERE agent_id = ?').run(agentId);
        for (const relPath of listGuardedFiles(workspaceDir)) {
          try {
            setBaseline(agentId, relPath, readGuardedFile(path.join(workspaceDir, relPath)));
          } catch {
            // 二进制或超大文件不纳入守护
          }
        }
        sql.prepare('INSERT INTO write_gate_settings (agent_id, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(agent_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at').run(agentId, now());
      });
      snapshot();
      startWatching(agentId, workspaceDir);
    } else {
      stopWatching(agentId);
      sql.prepare('INSERT INTO write_gate_settings (agent_id, enabled, updated_at) VALUES (?, 0, ?) ON CONFLICT(agent_id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at').run(agentId, now());
      sql.prepare('DELETE FROM write_gate_baselines WHERE agent_id = ?').run(agentId);
    }
  }

  /** 服务启动：给已开启的 Agent 恢复监听。解析不到工作区的跳过并记日志，不阻塞启动。 */
  async function start(): Promise<void> {
    for (const setting of listSettings().filter((entry) => entry.enabled)) {
      try {
        startWatching(setting.agentId, await resolveWorkspace(setting.agentId));
      } catch {
        log(`[WriteGate] could not resume watcher for ${setting.agentId}`);
      }
    }
  }

  function stop(): void {
    for (const agentId of [...watchers.keys()]) stopWatching(agentId);
  }

  /** ClawOPT 自己的编辑器写受守护文件前调用：登记预期内容、写后更新基线。 */
  function acknowledgeWrite(agentId: string, relPath: string, content: string | null): void {
    if (!isGuardedPath(relPath) || !isEnabled(agentId)) return;
    expectedWrites.set(key(agentId, relPath), hashContent(content));
    setBaseline(agentId, relPath, content);
  }

  function listPending(agentId?: string): { records: PendingWriteSummary[]; counts: Record<string, number> } {
    const rows = (agentId
      ? sql.prepare('SELECT * FROM write_gate_pending WHERE agent_id = ? ORDER BY created_at').all(agentId)
      : sql.prepare('SELECT * FROM write_gate_pending ORDER BY created_at').all()) as PendingWriteRow[];
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.agent_id] = (counts[row.agent_id] ?? 0) + 1;
    return { records: rows.map(summarize), counts };
  }

  function getRow(id: string): PendingWriteRow {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new ControlInputError('writeGate.invalidId');
    const row = sql.prepare('SELECT * FROM write_gate_pending WHERE id = ?').get(id) as PendingWriteRow | undefined;
    if (!row) throw new ControlInputError('writeGate.notFound', 404);
    return row;
  }

  function review(id: string) {
    const row = getRow(id);
    let current: string | null = null;
    let currentReadFailed = false;
    try {
      current = readGuardedFile(path.join(row.workspace_dir, row.rel_path));
    } catch {
      currentReadFailed = true;
    }
    const currentHash = hashContent(current);
    const notes: string[] = [];
    if (currentReadFailed) notes.push('currentReadFailed');
    else if (currentHash !== row.base_hash) notes.push('baseChanged');
    if (!currentReadFailed && currentHash === row.proposed_hash) notes.push('noOp');
    if (row.base_content === null) notes.push('createFile');
    if (row.proposed_content === null) notes.push('deleteFile');
    return {
      record: summarize(row),
      base: row.base_content,
      proposed: row.proposed_content,
      current,
      diff: unifiedDiff(row.base_content ?? '', row.proposed_content ?? '', { from: `a/${row.rel_path}`, to: `b/${row.rel_path}` }),
      notes,
    };
  }

  /** 同一个解析后的工作区目录上的批准 / 拒绝串行执行。 */
  function serialized<T>(dir: string, task: () => Promise<T>): Promise<T> {
    let resolvedDir = dir;
    try {
      resolvedDir = fs.realpathSync(dir);
    } catch {
      // 目录没了也要排队，按原字符串
    }
    const previous = dirQueues.get(resolvedDir) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    dirQueues.set(resolvedDir, tail);
    void tail.then(() => {
      if (dirQueues.get(resolvedDir) === tail) dirQueues.delete(resolvedDir);
    });
    return next;
  }

  function assertReviewedRecord(row: PendingWriteRow, reviewed: { baseHash?: unknown; proposedHash?: unknown }) {
    // 审阅之后记录又被新的改动覆盖（proposed 变了）：审的不是现在要批的东西。
    if ((reviewed.baseHash ?? null) !== row.base_hash || (reviewed.proposedHash ?? null) !== row.proposed_hash) {
      throw new ControlInputError('writeGate.recordChanged', 409);
    }
  }

  async function approve(id: string, reviewed: { baseHash?: unknown; proposedHash?: unknown }) {
    const initial = getRow(id);
    return serialized(initial.workspace_dir, async () => {
      const row = getRow(id);
      assertReviewedRecord(row, reviewed);
      const filePath = path.join(row.workspace_dir, row.rel_path);
      let current: string | null;
      try {
        current = readGuardedFile(filePath);
      } catch {
        throw new ControlInputError('writeGate.currentReadFailed', 409);
      }
      const currentHash = hashContent(current);
      if (currentHash === row.proposed_hash) {
        sql.prepare('DELETE FROM write_gate_pending WHERE id = ?').run(id);
        setBaseline(row.agent_id, row.rel_path, current);
        return { applied: false, noOp: true };
      }
      if (currentHash !== row.base_hash) throw new ControlInputError('writeGate.baseChanged', 409);

      const writeKey = key(row.agent_id, row.rel_path);
      expectedWrites.set(writeKey, row.proposed_hash);
      if (row.proposed_content === null) {
        fs.rmSync(filePath, { force: true });
      } else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        await deps.fileStore.update(filePath, () => ({ next: row.proposed_content as string }));
      }
      setBaseline(row.agent_id, row.rel_path, row.proposed_content);
      sql.prepare('DELETE FROM write_gate_pending WHERE id = ?').run(id);
      const stillThere = sql.prepare('SELECT 1 FROM write_gate_pending WHERE id = ?').get(id);
      if (stillThere) throw new ControlInputError('writeGate.approveNotVerified', 500);
      return { applied: true, noOp: false };
    });
  }

  async function reject(id: string) {
    const initial = getRow(id);
    return serialized(initial.workspace_dir, async () => {
      getRow(id);
      sql.prepare('DELETE FROM write_gate_pending WHERE id = ?').run(id);
      return { rejected: true };
    });
  }

  return { listSettings, setEnabled, isEnabled, start, stop, handleChange, acknowledgeWrite, listPending, review, approve, reject };
}

export type WriteGateService = ReturnType<typeof createWriteGateService>;
