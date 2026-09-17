// 文件管理器的纯逻辑：路径拼接、面包屑、git 标注、大小格式、分块上传驱动（接口可注入，带单测）。

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

export type GitStatus = 'conflicted' | 'modified' | 'renamed' | 'deleted' | 'added' | 'untracked';

export type FileEntry = {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
  git: { status: GitStatus | null; changedDescendants: number } | null;
};

export type ListResult = { root: RootView; path: string; git: { state: string }; entries: FileEntry[] };

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentPath(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index === -1 ? '' : relPath.slice(0, index);
}

export function baseName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath;
}

/** 面包屑：根 + 每一段（点击回到那一层）。 */
export function breadcrumbs(relPath: string): Array<{ label: string; path: string }> {
  const segments = relPath.split('/').filter(Boolean);
  return segments.map((segment, index) => ({ label: segment, path: segments.slice(0, index + 1).join('/') }));
}

/** 新名字只许是一个文件名（与后端 validateEntryName 同判据）。 */
export function isValidEntryName(name: string): boolean {
  const trimmed = name.trim();
  return Boolean(trimmed) && trimmed !== '.' && trimmed !== '..' && trimmed.length <= 255 && !/[/\\\0\r\n]/.test(trimmed);
}

export const GIT_BADGE: Record<GitStatus, { letter: string; tone: 'red' | 'amber' | 'green' | 'blue' | 'gray' }> = {
  conflicted: { letter: 'C', tone: 'red' },
  modified: { letter: 'M', tone: 'amber' },
  renamed: { letter: 'R', tone: 'blue' },
  deleted: { letter: 'D', tone: 'red' },
  added: { letter: 'A', tone: 'green' },
  untracked: { letter: 'U', tone: 'green' },
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** 根分组：Agent 工作区 / 额外根 / 远端。 */
export function groupRoots(roots: RootView[]): Array<{ group: 'agents' | 'extra' | 'remote'; roots: RootView[] }> {
  const groups: Array<{ group: 'agents' | 'extra' | 'remote'; roots: RootView[] }> = [
    { group: 'agents', roots: roots.filter((root) => root.kind === 'agent') },
    { group: 'extra', roots: roots.filter((root) => root.kind === 'extra') },
    { group: 'remote', roots: roots.filter((root) => root.kind === 'ssh' || root.kind === 'docker') },
  ];
  return groups.filter((group) => group.roots.length > 0);
}

// ---- 可续传分块上传驱动 ----

export type UploadSessionView = { id: string; nextOffset: number; size: number; maxChunkBytes: number };

export type UploadApi = {
  begin: (input: { root: string; dir: string; name: string; size: number; overwrite?: boolean }) => Promise<{ ok: boolean; status: number; upload?: UploadSessionView; errorCode?: string }>;
  status: (uploadId: string) => Promise<{ ok: boolean; status: number; upload?: UploadSessionView }>;
  chunk: (uploadId: string, offset: number, chunk: Blob, signal?: AbortSignal) => Promise<{ ok: boolean; status: number; upload?: UploadSessionView; nextOffset?: number; errorCode?: string }>;
  complete: (uploadId: string) => Promise<{ ok: boolean; status: number; errorCode?: string }>;
};

export type UploadProgress = { uploadId: string; sent: number; total: number };

export type UploadOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; uploadId: string | null; sent: number; errorCode: string | null; status: number };

/**
 * 从 `resumeId` 接着传（先问服务端下一段偏移），没有就新开会话。
 * 服务端回 409 偏移不符时按它给的偏移对齐后继续；其余失败把会话 id 交回，界面可「继续上传」。
 */
export async function runChunkedUpload(options: {
  api: UploadApi;
  file: Blob;
  root: string;
  dir: string;
  name: string;
  overwrite?: boolean;
  resumeId?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  maxRealignments?: number;
}): Promise<UploadOutcome> {
  const { api, file } = options;
  let session: UploadSessionView | undefined;
  if (options.resumeId) {
    const status = await options.api.status(options.resumeId);
    if (status.ok && status.upload && status.upload.size === file.size) session = status.upload;
  }
  if (!session) {
    const begun = await api.begin({ root: options.root, dir: options.dir, name: options.name, size: file.size, overwrite: options.overwrite });
    if (!begun.ok || !begun.upload) return { kind: 'failed', uploadId: null, sent: 0, errorCode: begun.errorCode ?? null, status: begun.status };
    session = begun.upload;
  }
  let offset = session.nextOffset;
  let realignments = 0;
  options.onProgress?.({ uploadId: session.id, sent: offset, total: file.size });
  while (offset < file.size) {
    if (options.signal?.aborted) return { kind: 'failed', uploadId: session.id, sent: offset, errorCode: 'fileManager.uploadCancelled', status: 0 };
    const end = Math.min(file.size, offset + session.maxChunkBytes);
    let result: Awaited<ReturnType<UploadApi['chunk']>>;
    try {
      result = await api.chunk(session.id, offset, file.slice(offset, end), options.signal);
    } catch {
      return { kind: 'failed', uploadId: session.id, sent: offset, errorCode: null, status: 0 };
    }
    if (result.ok && result.upload) {
      offset = result.upload.nextOffset;
    } else if (result.status === 409 && typeof result.nextOffset === 'number' && realignments < (options.maxRealignments ?? 3)) {
      realignments += 1;
      offset = result.nextOffset;
    } else {
      return { kind: 'failed', uploadId: session.id, sent: offset, errorCode: result.errorCode ?? null, status: result.status };
    }
    options.onProgress?.({ uploadId: session.id, sent: offset, total: file.size });
  }
  const completed = await api.complete(session.id);
  if (!completed.ok) return { kind: 'failed', uploadId: session.id, sent: offset, errorCode: completed.errorCode ?? null, status: completed.status };
  return { kind: 'done' };
}
