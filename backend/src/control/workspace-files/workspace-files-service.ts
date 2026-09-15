/**
 * Agent 工作区身份文件编辑器：SOUL / USER / MEMORY / AGENTS / IDENTITY / TOOLS / HEARTBEAT。
 *
 * - **路径不来自请求**：文件名只能是上面七个之一；工作区目录取引擎名册（`agents list --json`）报的路径，
 *   realpath 之后再拼文件名，已存在的文件 realpath 必须仍在工作区内（软链逃逸即拒）、必须是普通文件。
 * - **写入带前置条件**：版本号 = 内容 SHA-256（文件不存在为 `absent`）。比对与写入都在 SafeFileStore 的
 *   跨进程锁内完成——锁外比完再写，中间被 Agent 改了照样丢更新。不符 412 + 当前内容。
 * - 写入审批开着时，先向写入审批登记「这是 ClawOPT 自己的写入」，避免被当成外部改动暂存。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { SafeFileStore } from '../../core/files';
import { readTextFileSafe } from '../../openclaw';
import { ControlInputError, requireString } from '../shared/control-http';
import type { EngineRoster } from '../shared/engine-roster';
import type { WriteGateService } from '../write-gate/write-gate-service';

export const WORKSPACE_IDENTITY_FILES = ['SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md', 'IDENTITY.md', 'TOOLS.md', 'HEARTBEAT.md'] as const;
export type WorkspaceIdentityFile = typeof WORKSPACE_IDENTITY_FILES[number];

const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const ABSENT_REVISION = 'absent';

export function contentRevision(content: string | null): string {
  return content === null ? ABSENT_REVISION : crypto.createHash('sha256').update(content).digest('hex');
}

/** 粗估 token：CJK 字符按 1 个、其余按 4 字符 1 个。只用于界面提示，不参与任何限额判断。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function assertIdentityFile(name: unknown): WorkspaceIdentityFile {
  const text = requireString(name, 'workspaceFiles.invalidName');
  if (!(WORKSPACE_IDENTITY_FILES as readonly string[]).includes(text)) throw new ControlInputError('workspaceFiles.invalidName');
  return text as WorkspaceIdentityFile;
}

export class RevisionConflict extends Error {
  constructor(readonly current: { content: string | null; revision: string }) {
    super('REVISION_CONFLICT');
  }
}

/** 解析工作区内的身份文件路径；存在的文件必须是工作区内的普通文件。 */
export function resolveIdentityFilePath(workspaceDir: string, name: WorkspaceIdentityFile): string {
  let realWorkspace: string;
  try {
    realWorkspace = fs.realpathSync(workspaceDir);
  } catch {
    throw new ControlInputError('workspaceFiles.workspaceMissing', 404);
  }
  const candidate = path.join(realWorkspace, name);
  try {
    const real = fs.realpathSync(candidate);
    // 软链指到工作区外、或指向目录 / 管道：都拒绝。
    if (path.dirname(real) !== realWorkspace || !fs.statSync(real).isFile()) {
      throw new ControlInputError('workspaceFiles.unsafePath', 403);
    }
    return real;
  } catch (error) {
    if (error instanceof ControlInputError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate;
    throw new ControlInputError('workspaceFiles.unsafePath', 403);
  }
}

/** 经网关读（命名管道、目录一律拒绝，报错不带路径）。 */
function readIfExists(filePath: string): string | null {
  try {
    const text = readTextFileSafe(filePath);
    return text.exists ? String(text.value) : null;
  } catch {
    throw new ControlInputError('workspaceFiles.unsafePath', 403);
  }
}

export function createWorkspaceFilesService(deps: { roster: EngineRoster; fileStore: SafeFileStore; writeGate?: WriteGateService }) {
  async function workspaceOf(agentId: string): Promise<string> {
    const agent = await deps.roster.get(agentId);
    if (!agent.workspace) throw new ControlInputError('workspaceFiles.workspaceMissing', 404);
    return agent.workspace;
  }

  async function list(agentId: string) {
    const workspace = await workspaceOf(agentId);
    const files = WORKSPACE_IDENTITY_FILES.map((name) => {
      const filePath = resolveIdentityFilePath(workspace, name);
      const content = readIfExists(filePath);
      let mtimeMs: number | null = null;
      try {
        mtimeMs = content === null ? null : fs.statSync(filePath).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      return {
        name,
        exists: content !== null,
        size: content === null ? 0 : Buffer.byteLength(content),
        chars: content === null ? 0 : [...content].length,
        estimatedTokens: content === null ? 0 : estimateTokens(content),
        mtimeMs,
        revision: contentRevision(content),
      };
    });
    return { files };
  }

  async function read(agentId: string, rawName: unknown) {
    const name = assertIdentityFile(rawName);
    const filePath = resolveIdentityFilePath(await workspaceOf(agentId), name);
    const content = readIfExists(filePath);
    return {
      name,
      exists: content !== null,
      content: content ?? '',
      chars: content === null ? 0 : [...content].length,
      estimatedTokens: content === null ? 0 : estimateTokens(content),
      mtimeMs: content === null ? null : fs.statSync(filePath).mtimeMs,
      revision: contentRevision(content),
    };
  }

  async function write(agentId: string, rawName: unknown, content: unknown, requestedRevision: string | null) {
    const name = assertIdentityFile(rawName);
    if (typeof content !== 'string') throw new ControlInputError('workspaceFiles.invalidContent');
    if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) throw new ControlInputError('workspaceFiles.contentTooLarge', 413);
    if (!requestedRevision) throw new ControlInputError('REVISION_REQUIRED', 428);
    const filePath = resolveIdentityFilePath(await workspaceOf(agentId), name);

    const outcome = await deps.fileStore.update<{ conflict: { content: string | null; revision: string } } | undefined>(filePath, (current) => {
      const currentRevision = contentRevision(current);
      if (currentRevision !== requestedRevision) {
        return { abort: true, result: { conflict: { content: current, revision: currentRevision } } };
      }
      deps.writeGate?.acknowledgeWrite(agentId, name, content);
      return { next: content };
    });
    if (!outcome.written && outcome.result?.conflict) throw new RevisionConflict(outcome.result.conflict);
    return { revision: contentRevision(content) };
  }

  return { list, read, write };
}

export type WorkspaceFilesService = ReturnType<typeof createWorkspaceFilesService>;
