/**
 * 文件管理器（P6，spec 07 §2.8 / §2.9 / §2.13 / §2.14 / §3.3）：可插拔后端（本地 / SSH / Docker）、
 * 根只限 Agent 工作区与管理员配置的额外根与远端连接、git 状态标注、可续传分块上传。
 *
 * ## 授权（判据只在这里与路由闸门；spec 07 §3.2 第 1、3、4、5 条是反面教材）
 *
 * | 根 | 读（列表 / 详情 / 读 / 下载 / 预览） | 改（写 / 改名 / 复制 / 删 / 新建目录 / 上传） |
 * |---|---|---|
 * | `agent:<id>` Agent 工作区 | `canAccessAgent`（member 只见自己的）；读内容与下载另过可服务路径闸门 + `canAccessServedFile`，顺序固定 | admin |
 * | `extra:<id>` 额外根 | admin | admin |
 * | `ssh:<id>` / `docker:<id>` 远端 | admin，且主机能力闸门放行 | admin |
 * | 额外根、远端连接、known_hosts 的配置 | super_admin | super_admin |
 *
 * 路由层先挂闸门（登记表可见），这里再按身份复查一遍——服务被别处调用时不因少挂一个中间件而放大。
 *
 * ## 路径
 *
 * 客户端只给「根 id + 相对路径」：相对路径过 `normalizeRelativePath`（无绝对路径、无 `..`、无 NUL），
 * 源与目标都过敏感文件判据（与 served-paths 同一份清单），包含判定在后端里（本地按 realpath，远端按 `pwd -P`）。
 */
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import type { Readable } from 'stream';

import { roleAtLeast, type RequestIdentity, type ResourceAccess } from '../../../core/auth';
import type { DB } from '../../../core/db';
import { resolveServablePath, servedPathOwner } from '../../../core/files';
import { clawoptDataDir } from '../../../core/paths';
import type { HostCapabilities } from '../../../runtime';
import { createDockerBackend, validateContainer } from './backends/docker-backend';
import type { RemoteRunner, RemoteStreamer } from './backends/remote-shell';
import { createLocalBackend } from './backends/local-backend';
import { createSshBackend, validateRemoteRoot, validateSshHost, validateSshPort, validateSshUser } from './backends/ssh-backend';
import type { FileBackend, FileEntry } from './backends/types';
import { createChunkedUploads, type UploadView } from './chunked-upload';
import { FileManagerError, fmError } from './file-manager-errors';
import { isRegularFile, statDirectoryReal } from './file-manager-fs';
import { createFileManagerStore, type ConnectionRow } from './file-manager-store';
import { defaultGitRunner, gitDecorationsFor, type GitDecoration } from './git-status';
import { createKnownHosts, type KeyscanRunner } from './known-hosts';
import { assertNotDenied, isDeniedRelativePath, isInside, joinRelative, normalizeRelativePath, parentOf, validateEntryName } from './path-policy';

export const FILE_MANAGER_EDIT_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_MANAGER_DOWNLOAD_MAX_BYTES = 200 * 1024 * 1024;

export type FileManagerServiceDeps = {
  db: DB;
  access: ResourceAccess;
  /** Agent 工作区（OpenClaw 名册；取不到时按 `workspace-<id>` 约定兜底）。 */
  listAgentWorkspaces: () => Promise<Array<{ agentId: string; workspace: string }>>;
  hostCapabilities: () => Promise<HostCapabilities>;
  /** 以下只给测试注入。 */
  dataDir?: string;
  homeDir?: string;
  remoteRunner?: RemoteRunner;
  remoteStreamer?: RemoteStreamer;
  keyscanRunner?: KeyscanRunner;
  gitRunner?: Parameters<typeof gitDecorationsFor>[2];
  now?: () => number;
};

export type RootKind = 'agent' | 'extra' | 'ssh' | 'docker';

export type RootView = {
  id: string;
  kind: RootKind;
  label: string;
  agentId?: string;
  backend: 'local' | 'ssh' | 'docker';
  writable: boolean;
  available: boolean;
  reasonCode: string | null;
};

type ResolvedRoot = { view: RootView; backend: FileBackend; localPath: string | null };

export type ListedEntry = FileEntry & { git: GitDecoration | null };

const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

export function fileManagerOwnerKey(identity: Pick<RequestIdentity, 'userId'>): string {
  return identity.userId === null ? 'implicit' : `user:${identity.userId}`;
}

/**
 * 额外根的路径闸门：必须是存在的目录；拒绝 `/`、家目录本身与它的祖先、`~/.openclaw`（工作区已作为 Agent 根单独授权，
 * 根目录本身有 openclaw.json 与 agents/ 凭据）、ClawOPT 数据目录（数据库与本机密钥）、系统目录、敏感目录名。
 */
export async function validateExtraRootPath(candidate: unknown, context: { home: string; dataDir: string }): Promise<string> {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate.trim()) || candidate.includes('\0')) throw fmError.invalidInput('path');
  const real = await statDirectoryReal(candidate.trim());
  if (!real) throw new FileManagerError('fileManager.extraRootNotDirectory', 400);
  const realOrSelf = async (value: string) => (await statDirectoryReal(value)) ?? path.resolve(value);
  const home = await realOrSelf(context.home);
  const openclaw = await realOrSelf(path.join(context.home, '.openclaw'));
  const dataDir = await realOrSelf(context.dataDir);
  const forbidden = (reason: string) => new FileManagerError('fileManager.extraRootForbidden', 400, null, { reason });
  if (real === path.parse(real).root) throw forbidden('filesystemRoot');
  // `~/.openclaw` 按路径判（不管存不存在）：它的祖先包含家目录本身与家目录的全部祖先，一条判据同时挡住两类。
  if (isInside(real, openclaw) || isInside(openclaw, real)) throw forbidden(isInside(home, real) ? 'homeOrAncestor' : 'openclaw');
  if (isInside(real, dataDir) || isInside(dataDir, real)) throw forbidden('clawoptData');
  for (const system of ['/etc', '/proc', '/sys', '/dev', '/boot', '/root', '/var/root', '/private/etc', '/System', '/usr', '/bin', '/sbin']) {
    if (isInside(real, system)) throw forbidden('system');
  }
  const segments = real.split(path.sep).filter(Boolean);
  if (segments.length && isDeniedRelativePath(segments.join('/'))) throw forbidden('sensitive');
  return real;
}

export function createFileManagerService(deps: FileManagerServiceDeps) {
  const now = deps.now ?? Date.now;
  const dataDir = path.join(deps.dataDir ?? clawoptDataDir, 'file-manager');
  const home = deps.homeDir ?? os.homedir();
  const store = createFileManagerStore(deps.db.connection(), now);
  const knownHostsFile = path.join(dataDir, 'known_hosts');
  const knownHosts = createKnownHosts({ file: knownHostsFile, runner: deps.keyscanRunner, now });
  const uploads = createChunkedUploads({ dir: path.join(dataDir, 'uploads'), now });
  const locks = new Map<string, Promise<unknown>>();
  const { access } = deps;

  const isAdmin = (identity: RequestIdentity) => access.isAdmin(identity);
  const requireAdmin = (identity: RequestIdentity) => {
    if (!isAdmin(identity)) throw fmError.adminRequired();
  };
  const requireSuperAdmin = (identity: RequestIdentity) => {
    if (!roleAtLeast(identity.role, 'super_admin')) throw fmError.adminRequired();
  };

  async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    locks.set(key, run);
    try {
      return await run;
    } finally {
      if (locks.get(key) === run) locks.delete(key);
    }
  }

  async function hostGates(): Promise<HostCapabilities['gates'] | null> {
    try {
      return (await deps.hostCapabilities()).gates;
    } catch {
      return null;
    }
  }

  function connectionView(row: ConnectionRow, gates: HostCapabilities['gates'] | null): RootView {
    const gate = row.kind === 'ssh' ? gates?.fileManagerSsh : gates?.fileManagerDocker;
    const available = gate ? gate.allowed : false;
    return {
      id: `${row.kind}:${row.id}`,
      kind: row.kind,
      label: row.name,
      backend: row.kind,
      writable: true,
      available,
      reasonCode: available ? null : (gate?.reason ?? (row.kind === 'ssh' ? 'host.sshMissing' : 'host.dockerMissing')),
    };
  }

  async function listRoots(identity: RequestIdentity): Promise<RootView[]> {
    const workspaces = await deps.listAgentWorkspaces().catch(() => []);
    const admin = isAdmin(identity);
    const roots: RootView[] = workspaces
      .filter((entry) => access.canAccessAgent(identity, entry.agentId))
      .map((entry) => ({ id: `agent:${entry.agentId}`, kind: 'agent' as const, label: entry.agentId, agentId: entry.agentId, backend: 'local' as const, writable: admin, available: true, reasonCode: null }));
    if (!admin) return roots;
    for (const row of store.listExtraRoots()) {
      roots.push({ id: `extra:${row.id}`, kind: 'extra', label: row.name, backend: 'local', writable: true, available: true, reasonCode: null });
    }
    const gates = await hostGates();
    for (const row of store.listConnections()) roots.push(connectionView(row, gates));
    return roots;
  }

  async function resolveRoot(identity: RequestIdentity, rootId: unknown): Promise<ResolvedRoot> {
    if (typeof rootId !== 'string' || !rootId.includes(':')) throw fmError.rootNotFound();
    const separator = rootId.indexOf(':');
    const kind = rootId.slice(0, separator);
    const id = rootId.slice(separator + 1);
    if (kind === 'agent') {
      // 不存在与无权对 member 不可区分。
      if (!access.canAccessAgent(identity, id)) throw fmError.forbidden();
      const entry = (await deps.listAgentWorkspaces().catch(() => [])).find((item) => item.agentId === id);
      if (!entry) throw isAdmin(identity) ? fmError.rootNotFound() : fmError.forbidden();
      return {
        view: { id: rootId, kind: 'agent', label: id, agentId: id, backend: 'local', writable: isAdmin(identity), available: true, reasonCode: null },
        backend: createLocalBackend(entry.workspace),
        localPath: entry.workspace,
      };
    }
    requireAdmin(identity);
    if (kind === 'extra') {
      const row = store.getExtraRoot(id);
      if (!row) throw fmError.rootNotFound();
      return { view: { id: rootId, kind: 'extra', label: row.name, backend: 'local', writable: true, available: true, reasonCode: null }, backend: createLocalBackend(row.path), localPath: row.path };
    }
    if (kind === 'ssh' || kind === 'docker') {
      const row = store.getConnection(id);
      if (!row || row.kind !== kind) throw fmError.rootNotFound();
      const view = connectionView(row, await hostGates());
      if (!view.available) throw fmError.backendUnavailable(view.reasonCode ?? 'host.sshMissing');
      const backend = row.kind === 'ssh'
        ? createSshBackend({ host: row.host ?? '', port: row.port ?? 22, user: row.user ?? '', rootPath: row.rootPath, keyPath: row.keyPath }, { knownHostsFile, runner: deps.remoteRunner, streamer: deps.remoteStreamer })
        : createDockerBackend({ container: row.container ?? '', rootPath: row.rootPath }, { runner: deps.remoteRunner, streamer: deps.remoteStreamer });
      return { view, backend, localPath: null };
    }
    throw fmError.rootNotFound();
  }

  /** Agent 工作区里的文件发出去之前的两道门：可服务路径闸门 → 数据面授权（AGENTS.md 的固定顺序）。 */
  async function servedGates(identity: RequestIdentity, root: ResolvedRoot, relPath: string): Promise<string | null> {
    if (root.view.kind !== 'agent') return null;
    const real = await root.backend.localRealPath(relPath);
    if (!real) throw fmError.forbidden();
    const verdict = resolveServablePath(real);
    if (!verdict.ok) throw verdict.reason === 'notFound' ? fmError.notFound() : verdict.reason === 'deniedFile' ? fmError.deniedFile() : fmError.outsideRoot();
    if (!access.canAccessServedFile(identity, servedPathOwner(verdict.realPath))) throw fmError.forbidden();
    return verdict.realPath;
  }

  const relOf = (value: unknown) => {
    const rel = normalizeRelativePath(value);
    assertNotDenied(rel);
    return rel;
  };

  async function readCurrent(backend: FileBackend, rel: string): Promise<{ revision: string; content: string | null }> {
    try {
      const buffer = await backend.read(rel, FILE_MANAGER_EDIT_MAX_BYTES);
      return { revision: sha256(buffer), content: looksBinary(buffer) ? null : buffer.toString('utf8') };
    } catch (error) {
      if (error instanceof FileManagerError && error.errorCode === 'fileManager.notFound') return { revision: 'absent', content: null };
      throw error;
    }
  }

  return {
    listRoots,

    async list(identity: RequestIdentity, input: { root: unknown; path: unknown }) {
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      const entries = (await root.backend.list(rel))
        .filter((entry) => !isDeniedRelativePath(entry.path))
        .sort((a, b) => (a.kind === 'dir') === (b.kind === 'dir') ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1);
      let git: { state: string; repoRoot?: boolean } = { state: 'unsupported' };
      let decorations: Record<string, GitDecoration> = {};
      if (root.backend.kind === 'local') {
        const real = await root.backend.localRealPath(rel);
        if (real) {
          const result = await gitDecorationsFor(real, entries.map((entry) => entry.name), deps.gitRunner ?? defaultGitRunner);
          git = { state: result.state };
          if (result.state === 'ok') decorations = result.byName;
        }
      }
      return {
        root: root.view,
        path: rel,
        git,
        entries: entries.map((entry): ListedEntry => ({ ...entry, git: decorations[entry.name] ?? null })),
      };
    },

    async stat(identity: RequestIdentity, input: { root: unknown; path: unknown }) {
      const root = await resolveRoot(identity, input.root);
      return { root: root.view, entry: await root.backend.stat(relOf(input.path)) };
    },

    async read(identity: RequestIdentity, input: { root: unknown; path: unknown }) {
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      await servedGates(identity, root, rel);
      const buffer = await root.backend.read(rel, FILE_MANAGER_EDIT_MAX_BYTES);
      if (looksBinary(buffer)) throw fmError.notText();
      return { path: rel, content: buffer.toString('utf8'), revision: sha256(buffer), size: buffer.length, writable: root.view.writable };
    },

    /** 带版本号的写：`revision` 必须是读到时的内容 SHA-256（新文件为 `absent`）；比对与写入在同一把锁里。 */
    async write(identity: RequestIdentity, input: { root: unknown; path: unknown; content: unknown; revision: string | null }) {
      requireAdmin(identity);
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      if (!rel) throw fmError.invalidPath();
      if (typeof input.content !== 'string') throw fmError.invalidInput('content');
      const data = Buffer.from(input.content, 'utf8');
      if (data.length > FILE_MANAGER_EDIT_MAX_BYTES) throw fmError.tooLarge(FILE_MANAGER_EDIT_MAX_BYTES);
      if (!input.revision) throw fmError.revisionRequired();
      return withLock(`${root.view.id}\0${rel}`, async () => {
        const current = await readCurrent(root.backend, rel);
        if (current.revision !== input.revision) {
          throw fmError.revisionConflict({ revision: current.revision, value: { content: current.content ?? '', exists: current.revision !== 'absent' } });
        }
        await root.backend.write(rel, data);
        return { path: rel, revision: sha256(data), size: data.length };
      });
    },

    async mkdir(identity: RequestIdentity, input: { root: unknown; path: unknown }) {
      requireAdmin(identity);
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      if (!rel) throw fmError.invalidPath();
      validateEntryName(rel.split('/').pop());
      await root.backend.mkdir(rel);
      return { path: rel };
    },

    async rename(identity: RequestIdentity, input: { root: unknown; from: unknown; to: unknown }) {
      requireAdmin(identity);
      const root = await resolveRoot(identity, input.root);
      const from = relOf(input.from);
      const to = relOf(input.to);
      if (!from || !to) throw fmError.invalidPath();
      validateEntryName(to.split('/').pop());
      await withLock(`${root.view.id}\0${from}`, () => root.backend.rename(from, to));
      return { path: to };
    },

    async copy(identity: RequestIdentity, input: { root: unknown; from: unknown; to: unknown }) {
      requireAdmin(identity);
      const root = await resolveRoot(identity, input.root);
      const from = relOf(input.from);
      const to = relOf(input.to);
      if (!from || !to) throw fmError.invalidPath();
      validateEntryName(to.split('/').pop());
      await root.backend.copy(from, to);
      return { path: to };
    },

    async remove(identity: RequestIdentity, input: { root: unknown; path: unknown; recursive: unknown }) {
      requireAdmin(identity);
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      if (!rel) throw fmError.invalidPath();
      await withLock(`${root.view.id}\0${rel}`, () => root.backend.remove(rel, { recursive: input.recursive === true || input.recursive === 'true' || input.recursive === '1' }));
      return { path: rel };
    },

    async download(identity: RequestIdentity, input: { root: unknown; path: unknown }): Promise<{ name: string; size: number; stream: Readable }> {
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      if (!rel) throw fmError.isDirectory();
      await servedGates(identity, root, rel);
      const opened = await root.backend.openReadStream(rel, FILE_MANAGER_DOWNLOAD_MAX_BYTES);
      return { name: rel.split('/').pop() ?? 'download', ...opened };
    },

    /** 复用聊天页的预览组件：给出经 `/api/files/download` 的地址（那条路由自己再过两道门）。只有 Agent 工作区可预览。 */
    async previewLink(identity: RequestIdentity, input: { root: unknown; path: unknown }) {
      const root = await resolveRoot(identity, input.root);
      const rel = relOf(input.path);
      const real = await servedGates(identity, root, rel);
      if (!real) throw new FileManagerError('fileManager.previewUnsupported', 400);
      return { url: `/api/files/download?path=${encodeURIComponent(real)}`, name: rel.split('/').pop() ?? '' };
    },

    // ---- 分块上传 ----

    async beginUpload(identity: RequestIdentity, input: { root: unknown; dir: unknown; name: unknown; size: unknown; overwrite?: unknown }): Promise<UploadView> {
      requireAdmin(identity);
      const root = await resolveRoot(identity, input.root);
      const dir = relOf(input.dir);
      const name = validateEntryName(input.name);
      const target = joinRelative(dir, name);
      assertNotDenied(target);
      const dirEntry = await root.backend.stat(dir);
      if (dirEntry.kind !== 'dir') throw fmError.notDirectory();
      const overwrite = input.overwrite === true;
      if (!overwrite) {
        const exists = await root.backend.stat(target).then(() => true, (error) => {
          if (error instanceof FileManagerError && error.errorCode === 'fileManager.notFound') return false;
          throw error;
        });
        if (exists) throw fmError.exists();
      }
      return uploads.begin({ ownerKey: fileManagerOwnerKey(identity), rootId: root.view.id, dir, name, size: input.size, overwrite });
    },

    async uploadStatus(identity: RequestIdentity, uploadId: unknown) {
      requireAdmin(identity);
      return uploads.status(uploadId, fileManagerOwnerKey(identity));
    },

    async uploadChunk(identity: RequestIdentity, uploadId: unknown, offset: unknown, chunk: unknown) {
      requireAdmin(identity);
      return uploads.chunk(uploadId, fileManagerOwnerKey(identity), offset, chunk);
    },

    async completeUpload(identity: RequestIdentity, uploadId: unknown) {
      requireAdmin(identity);
      const { session, partFile } = await uploads.prepareComplete(uploadId, fileManagerOwnerKey(identity));
      let ok = false;
      try {
        const root = await resolveRoot(identity, session.rootId);
        const target = joinRelative(session.dir, session.name);
        assertNotDenied(target);
        if (!(await isRegularFile(partFile))) throw fmError.notFound();
        await withLock(`${root.view.id}\0${target}`, () => root.backend.writeFromLocalFile(target, partFile, { overwrite: session.overwrite }));
        ok = true;
        return { path: target, size: session.size, dir: parentOf(target) };
      } finally {
        await uploads.finish(session.id, ok);
      }
    },

    async abortUpload(identity: RequestIdentity, uploadId: unknown) {
      requireAdmin(identity);
      await uploads.abort(uploadId, fileManagerOwnerKey(identity));
    },

    // ---- 配置（super_admin） ----

    async config(identity: RequestIdentity) {
      requireSuperAdmin(identity);
      const gates = await hostGates();
      return {
        extraRoots: store.listExtraRoots(),
        connections: store.listConnections().map((row) => ({
          id: row.id,
          kind: row.kind,
          name: row.name,
          host: row.host,
          port: row.port,
          user: row.user,
          container: row.container,
          rootPath: row.rootPath,
          hasKey: Boolean(row.keyPath),
          available: connectionView(row, gates).available,
          reasonCode: connectionView(row, gates).reasonCode,
        })),
        gates: {
          ssh: gates?.fileManagerSsh ?? { allowed: false, reason: 'host.sshMissing' },
          docker: gates?.fileManagerDocker ?? { allowed: false, reason: 'host.dockerMissing' },
        },
        knownHosts: await knownHosts.list(),
      };
    },

    async addExtraRoot(identity: RequestIdentity, input: { name: unknown; path: unknown }) {
      requireSuperAdmin(identity);
      const real = await validateExtraRootPath(input.path, { home, dataDir: deps.dataDir ?? clawoptDataDir });
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : path.basename(real);
      if (store.listExtraRoots().some((row) => row.path === real)) throw fmError.exists();
      return store.addExtraRoot({ name, path: real });
    },

    async removeExtraRoot(identity: RequestIdentity, id: string) {
      requireSuperAdmin(identity);
      if (!store.removeExtraRoot(id)) throw fmError.rootNotFound();
    },

    /**
     * 远端连接。**没有**任何能关掉主机密钥校验的字段：认得的字段只有下面这些，多给的一律拒绝。
     * 私钥路径：空串 = 不修改，`null` = 清除；只存本机路径，永不回给前端。
     */
    async saveConnection(identity: RequestIdentity, input: Record<string, unknown>, id?: string) {
      requireSuperAdmin(identity);
      const allowed = new Set(['kind', 'name', 'host', 'port', 'user', 'keyPath', 'container', 'rootPath']);
      const unknownFields = Object.keys(input ?? {}).filter((key) => !allowed.has(key));
      if (unknownFields.length) throw fmError.invalidInput(unknownFields[0]);
      const existing = id ? store.getConnection(id) : null;
      if (id && !existing) throw fmError.rootNotFound();
      const kind = existing?.kind ?? input.kind;
      if (kind !== 'ssh' && kind !== 'docker') throw fmError.invalidInput('kind');
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 80) : null;
      if (!name) throw fmError.invalidInput('name');
      const rootPath = validateRemoteRoot(input.rootPath);
      if (kind === 'ssh') {
        let keyPath = existing?.keyPath ?? null;
        if (input.keyPath === null) keyPath = null;
        else if (typeof input.keyPath === 'string' && input.keyPath.trim()) {
          const candidate = input.keyPath.trim();
          if (!path.isAbsolute(candidate) || candidate.startsWith('-') || !(await isRegularFile(candidate))) throw fmError.invalidInput('keyPath');
          keyPath = candidate;
        }
        return store.saveConnection({ id, kind, name, host: validateSshHost(input.host), port: validateSshPort(input.port), user: validateSshUser(input.user), keyPath, container: null, rootPath });
      }
      return store.saveConnection({ id, kind, name, host: null, port: null, user: null, keyPath: null, container: validateContainer(input.container), rootPath });
    },

    async removeConnection(identity: RequestIdentity, id: string) {
      requireSuperAdmin(identity);
      if (!store.removeConnection(id)) throw fmError.rootNotFound();
    },

    async testConnection(identity: RequestIdentity, id: string) {
      requireSuperAdmin(identity);
      const row = store.getConnection(id);
      if (!row) throw fmError.rootNotFound();
      try {
        const listed = await this.list(identity, { root: `${row.kind}:${row.id}`, path: '' });
        return { ok: true, entries: listed.entries.length, errorCode: null, errorDetail: null };
      } catch (error) {
        if (error instanceof FileManagerError) return { ok: false, entries: 0, errorCode: error.errorCode, errorDetail: error.detail };
        throw error;
      }
    },

    async scanHostKeys(identity: RequestIdentity, input: { host: unknown; port: unknown }) {
      requireSuperAdmin(identity);
      const gates = await hostGates();
      if (gates?.fileManagerSsh && !gates.fileManagerSsh.allowed) throw fmError.backendUnavailable(gates.fileManagerSsh.reason ?? 'host.sshMissing');
      return knownHosts.scan(input);
    },

    async trustHostKeys(identity: RequestIdentity, input: { scanId: unknown; fingerprints: unknown }) {
      requireSuperAdmin(identity);
      return knownHosts.trust(input);
    },

    async removeHostKey(identity: RequestIdentity, input: { hostPattern: unknown; fingerprint: unknown }) {
      requireSuperAdmin(identity);
      return knownHosts.remove(input);
    },

    async stop(): Promise<void> {
      await uploads.stopAll();
    },
  };
}

export type FileManagerService = ReturnType<typeof createFileManagerService>;
