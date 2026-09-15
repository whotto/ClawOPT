/**
 * 每次运行的工作区 diff：`WorkspaceCheckpointer` 的实现（spec 01 §2.22）。
 *
 * - `begin`（交给运行时之前）：git 工作区记下 HEAD 与 `git status` 的脏路径及其内容快照；普通目录做有界扫描并快照内容。
 * - `complete`（投影器落完最终消息、知道消息 id 之后）：取「检查点里的路径 ∪ 现在的脏 / 扫描路径 ∪ 运行期间提交过的路径」，
 *   逐个比「运行前」与「现在」：运行前的版本优先用检查点快照，git 里检查点没有的取运行开始时的 HEAD。
 *   没变的、只差零行的跳过；改名（删一个、加一个、内容相同）合成 renamed；按上限截断；什么都没变就不落库、返回 null。
 *
 * 失败一律不影响运行：协调器会吞掉异常；这里自己也把每一步的失败降级成「少报」而不是抛出。
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fsp } from 'fs';

import type { WorkspaceRunChangeFileInput, WorkspaceRunChangeInput } from '../../../core/db';
import type { AdapterRunOutcome, WorkspaceRunChangeSummary } from '../../contract';
import type { RunSurface, WorkspaceCheckpoint, WorkspaceCheckpointer } from '../types';
import { diffLines, formatUnifiedPatch, looksBinary } from './line-diff';
import { WORKSPACE_DIFF_LIMITS, type WorkspaceDiffLimits } from './limits';
import { probeWorkspaceFile, type FileProbe } from './workspace-fs';
import {
  detectGitWorkspace,
  gitHead,
  listGitCommittedPaths,
  listGitDirtyPaths,
  readGitBlob,
  runGit,
  scanWorkspace,
  type GitRunner,
  type GitWorkspace,
} from './workspace-listing';

type Snapshot = { size: number; mtimeMs: number; content: Buffer | null };

interface CheckpointState {
  sessionKey: string;
  runId: string;
  runMarker: string;
  surface: RunSurface | null;
  rootReal: string;
  mode: 'git' | 'scan';
  git: GitWorkspace | null;
  snapshots: Map<string, Snapshot>;
  /** 开始时的列举被上限截断：检查点里没有的路径无从判断「运行前是什么」。 */
  beginTruncated: boolean;
}

export interface WorkspaceDiffStore {
  save(input: WorkspaceRunChangeInput): void;
}

export interface WorkspaceDiffCheckpointerOptions {
  store: WorkspaceDiffStore;
  limits?: Partial<WorkspaceDiffLimits>;
  git?: GitRunner;
  now?: () => number;
  log?: (message: string) => void;
}

type Candidate = {
  path: string;
  before: { kind: 'absent' } | { kind: 'present'; size: number; content: Buffer | null };
  after: { kind: 'absent' } | { kind: 'present'; size: number; content: Buffer | null };
};

type FileResult = WorkspaceRunChangeFileInput & { contentKey: string | null };

/** 改名配对用的内容指纹（只比内容，不存内容）。 */
const contentKeyOf = (content: Buffer | null) => (content ? `${content.length}:${createHash('sha256').update(content).digest('hex')}` : null);

export function createWorkspaceDiffCheckpointer(options: WorkspaceDiffCheckpointerOptions): WorkspaceCheckpointer {
  const limits: WorkspaceDiffLimits = { ...WORKSPACE_DIFF_LIMITS, ...(options.limits ?? {}) };
  const git = options.git ?? runGit;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));

  async function snapshotPaths(rootReal: string, paths: Iterable<string>): Promise<Map<string, Snapshot>> {
    const snapshots = new Map<string, Snapshot>();
    let budget = limits.snapshotBudgetBytes;
    // 读内容的时间同样有界：超出后只记大小与修改时间（之后改了照样报「改了」，只是没有 patch）。
    const deadline = now() + limits.scanBudgetMs * 2;
    for (const relPath of paths) {
      const wantContent = budget > 0 && now() <= deadline;
      const probe = await probeWorkspaceFile(rootReal, relPath, { maxBytes: limits.maxSnapshotBytes, wantContent });
      if (probe.kind !== 'present') continue;
      if (probe.content) budget -= probe.content.length;
      snapshots.set(relPath, { size: probe.size, mtimeMs: probe.mtimeMs, content: probe.content });
    }
    return snapshots;
  }

  async function begin(input: { sessionKey: string; runId: string; runMarker: string; workspacePath?: string; surface?: RunSurface }): Promise<WorkspaceCheckpoint | null> {
    if (!input.workspacePath) return null;
    let rootReal: string;
    try {
      rootReal = await fsp.realpath(input.workspacePath);
      if (!(await fsp.stat(rootReal)).isDirectory()) return null;
    } catch {
      return null;
    }
    const base = { sessionKey: input.sessionKey, runId: input.runId, runMarker: input.runMarker, surface: input.surface ?? null, rootReal };

    const gitWorkspace = await detectGitWorkspace(rootReal, git, limits);
    if (gitWorkspace) {
      const dirty = await listGitDirtyPaths(rootReal, gitWorkspace, git, limits);
      if (dirty) {
        const state: CheckpointState = { ...base, mode: 'git', git: gitWorkspace, snapshots: await snapshotPaths(rootReal, dirty.paths), beginTruncated: dirty.truncated };
        return { token: state };
      }
    }
    const scan = await scanWorkspace(rootReal, limits, now);
    const state: CheckpointState = {
      ...base,
      mode: 'scan',
      git: null,
      snapshots: await snapshotPaths(rootReal, scan.entries.map((entry) => entry.relPath)),
      beginTruncated: scan.truncated,
    };
    return { token: state };
  }

  async function currentPaths(state: CheckpointState): Promise<{ paths: Set<string>; truncated: boolean; headNow: string | null }> {
    const paths = new Set(state.snapshots.keys());
    if (state.mode === 'git' && state.git) {
      const dirty = await listGitDirtyPaths(state.rootReal, state.git, git, limits);
      const headNow = await gitHead(state.rootReal, git, limits);
      for (const relPath of dirty?.paths ?? []) paths.add(relPath);
      if (state.git.head && headNow && headNow !== state.git.head) {
        for (const relPath of await listGitCommittedPaths(state.rootReal, state.git, state.git.head, headNow, git, limits)) paths.add(relPath);
      }
      return { paths, truncated: !dirty || dirty.truncated, headNow };
    }
    const scan = await scanWorkspace(state.rootReal, limits, now);
    for (const entry of scan.entries) paths.add(entry.relPath);
    return { paths, truncated: scan.truncated, headNow: null };
  }

  function buildFile(candidate: Candidate): FileResult | null {
    const { before, after } = candidate;
    if (before.kind === 'absent' && after.kind === 'absent') return null;
    const changeType: FileResult['changeType'] = before.kind === 'absent' ? 'added' : after.kind === 'absent' ? 'deleted' : 'modified';
    const beforeContent = before.kind === 'present' ? before.content : Buffer.alloc(0);
    const afterContent = after.kind === 'present' ? after.content : Buffer.alloc(0);
    const oldSize = before.kind === 'present' ? before.size : null;
    const newSize = after.kind === 'present' ? after.size : null;
    const base = { path: candidate.path, oldPath: null, changeType, oldSize, newSize, contentKey: after.kind === 'present' ? contentKeyOf(after.content) : contentKeyOf(before.kind === 'present' ? before.content : null) };

    // 任何一边超过快照上限（上层已按大小与修改时间判过「变了」）：只报变了，不给 patch，标截断。
    if (beforeContent === null || afterContent === null) {
      return { ...base, additions: 0, deletions: 0, patch: null, patchBytes: 0, truncated: true, binary: false };
    }
    if (changeType === 'modified' && beforeContent.equals(afterContent)) return null;
    if (looksBinary(beforeContent) || looksBinary(afterContent)) {
      return { ...base, additions: 0, deletions: 0, patch: null, patchBytes: 0, truncated: false, binary: true };
    }
    const diff = diffLines(beforeContent.toString('utf8'), afterContent.toString('utf8'), limits.maxDiffEditDistance);
    if (diff.additions + diff.deletions === 0 && changeType === 'modified') return null;
    const patch = formatUnifiedPatch(diff.ops, {
      oldPath: changeType === 'added' ? null : candidate.path,
      newPath: changeType === 'deleted' ? null : candidate.path,
    });
    return { ...base, additions: diff.additions, deletions: diff.deletions, patch, patchBytes: Buffer.byteLength(patch), truncated: false, binary: false };
  }

  /** 删一个、加一个、内容逐字节相同 → 改名。 */
  function mergeRenames(files: FileResult[]): FileResult[] {
    const added = new Map<string, FileResult>();
    for (const file of files) if (file.changeType === 'added' && file.contentKey) added.set(file.contentKey, file);
    const consumed = new Set<FileResult>();
    const out: FileResult[] = [];
    for (const file of files) {
      if (file.changeType !== 'deleted' || !file.contentKey) continue;
      const target = added.get(file.contentKey);
      if (!target || consumed.has(target)) continue;
      consumed.add(target);
      consumed.add(file);
      added.delete(file.contentKey);
      out.push({ ...target, changeType: 'renamed', oldPath: file.path, oldSize: file.oldSize, additions: 0, deletions: 0, patch: null, patchBytes: 0, truncated: false });
    }
    return [...files.filter((file) => !consumed.has(file)), ...out].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async function complete(checkpoint: WorkspaceCheckpoint, input: { messageId: string | number | null; outcome: AdapterRunOutcome }): Promise<WorkspaceRunChangeSummary | null> {
    const state = checkpoint.token as CheckpointState;
    const { paths, truncated: listingTruncated } = await currentPaths(state);
    const deadline = now() + limits.completeBudgetMs;
    let truncated = listingTruncated;
    let blobReads = 0;
    const files: FileResult[] = [];

    for (const relPath of [...paths].sort()) {
      if (now() > deadline) { truncated = true; break; }
      const snapshot = state.snapshots.get(relPath);
      let before: Candidate['before'];
      if (snapshot) {
        before = { kind: 'present', size: snapshot.size, content: snapshot.content };
      } else if (state.mode === 'git' && state.git) {
        if (!state.git.head) {
          before = { kind: 'absent' };
        } else {
          if (blobReads >= limits.maxGitBlobReads) { truncated = true; continue; }
          blobReads += 1;
          before = await readGitBlob(state.rootReal, state.git, state.git.head, relPath, git, limits);
        }
      } else if (state.beginTruncated) {
        // 扫描开始时被截断：这个路径运行前可能就在，只是没扫到——不猜，标截断。
        truncated = true;
        continue;
      } else {
        before = { kind: 'absent' };
      }

      const stat: FileProbe = await probeWorkspaceFile(state.rootReal, relPath, { maxBytes: limits.maxSnapshotBytes, wantContent: false });
      if (stat.kind === 'skipped') continue;
      if (snapshot && stat.kind === 'present' && stat.size === snapshot.size && stat.mtimeMs === snapshot.mtimeMs) continue;
      let after: Candidate['after'] = { kind: 'absent' };
      if (stat.kind === 'present') {
        const probe = await probeWorkspaceFile(state.rootReal, relPath, { maxBytes: limits.maxSnapshotBytes, wantContent: true });
        if (probe.kind === 'skipped') continue;
        if (probe.kind === 'present') after = { kind: 'present', size: probe.size, content: probe.content };
      }
      const file = buildFile({ path: relPath, before, after });
      if (file) files.push(file);
    }

    const merged = mergeRenames(files);
    if (merged.length === 0) return null;

    let patchTotal = 0;
    const kept: WorkspaceRunChangeFileInput[] = [];
    for (const file of merged.slice(0, limits.maxFiles)) {
      const { contentKey: _contentKey, ...row } = file;
      if (row.patch !== null) {
        if (row.patchBytes > limits.maxPatchBytesPerFile || patchTotal + row.patchBytes > limits.maxPatchBytesTotal) {
          row.patch = null;
          row.truncated = true;
        } else {
          patchTotal += row.patchBytes;
        }
      }
      kept.push(row);
    }
    if (merged.length > limits.maxFiles) truncated = true;
    const additions = merged.reduce((sum, file) => sum + file.additions, 0);
    const deletions = merged.reduce((sum, file) => sum + file.deletions, 0);
    const changeId = randomUUID();
    const messageId = input.messageId === null || input.messageId === undefined ? null : String(input.messageId);
    const anyFileTruncated = kept.some((file) => file.truncated);

    try {
      options.store.save({
        id: changeId,
        sessionKey: state.sessionKey,
        surface: state.surface,
        runId: state.runId,
        runMarker: state.runMarker,
        assistantMessageId: messageId,
        mode: state.mode,
        workspaceRoot: state.rootReal,
        fileCount: merged.length,
        additions,
        deletions,
        patchBytes: patchTotal,
        truncated: truncated || anyFileTruncated,
        createdAt: now(),
        files: kept,
      });
    } catch (error) {
      log(`[WorkspaceDiff] persist failed for ${state.sessionKey}: ${(error as Error)?.message}`);
      return null;
    }

    return {
      changeId,
      messageId,
      fileCount: merged.length,
      additions,
      deletions,
      truncated: truncated || anyFileTruncated,
      files: kept.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
        truncated: file.truncated,
      })),
    };
  }

  return {
    begin: (input) => begin(input).catch((error) => {
      log(`[WorkspaceDiff] checkpoint failed for ${input.sessionKey}: ${(error as Error)?.message}`);
      return null;
    }),
    complete: (checkpoint, input) => complete(checkpoint, input).catch((error) => {
      log(`[WorkspaceDiff] diff failed: ${(error as Error)?.message}`);
      return null;
    }),
  };
}
