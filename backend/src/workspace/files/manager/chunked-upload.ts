/**
 * 可续传分块上传（spec 07 §2.13 超越版）：begin → 按严格偏移 PUT 块 → complete（原子落位）/ abort。
 *
 * - 会话归**用户**（userKey），别人的 id 一律 403；空闲 30 分钟过期，临时文件删掉；
 * - 临时文件在 ClawOPT 数据目录（`<数据目录>/file-manager/uploads/<id>.part`），不在根里——没传完的半截不会出现在 Agent 的工作区；
 * - 偏移必须恰好等于已收到的字节数（409 + 当前偏移，客户端据此续传）；同一会话同时只收一块（409 busy）；
 * - 块 ≤ 1 MiB、总大小 ≤ 声明值、声明值 ≤ 上限；服务重启后会话没了，客户端从头开始（状态接口回 404）。
 */
import crypto from 'crypto';
import path from 'path';

import { FileManagerError, fmError } from './file-manager-errors';
import { appendPartChunk, createEmptyPart, listDirNamesQuiet, partSize, removeFileQuiet } from './file-manager-fs';

export const UPLOAD_MAX_CHUNK_BYTES = 1024 * 1024;
export const UPLOAD_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const UPLOAD_IDLE_TTL_MS = 30 * 60 * 1000;

export type UploadSession = {
  id: string;
  ownerKey: string;
  rootId: string;
  dir: string;
  name: string;
  size: number;
  received: number;
  overwrite: boolean;
  busy: boolean;
  createdAt: number;
  lastActivityAt: number;
};

export type UploadView = Omit<UploadSession, 'ownerKey' | 'busy'> & { maxChunkBytes: number; nextOffset: number };

export function createChunkedUploads(options: { dir: string; now?: () => number; ttlMs?: number; maxTotalBytes?: number }) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? UPLOAD_IDLE_TTL_MS;
  const maxTotal = options.maxTotalBytes ?? UPLOAD_MAX_TOTAL_BYTES;
  const sessions = new Map<string, UploadSession>();
  const partPath = (id: string) => path.join(options.dir, `${id}.part`);
  let cleanedStale = false;

  const view = (session: UploadSession): UploadView => {
    const { ownerKey: _owner, busy: _busy, ...rest } = session;
    return { ...rest, nextOffset: session.received, maxChunkBytes: UPLOAD_MAX_CHUNK_BYTES };
  };

  async function sweep(): Promise<void> {
    if (!cleanedStale) {
      // 上次进程留下的半截：会话在内存里，重启后都是孤儿。
      cleanedStale = true;
      for (const name of await listDirNamesQuiet(options.dir)) if (name.endsWith('.part')) await removeFileQuiet(path.join(options.dir, name));
    }
    for (const session of [...sessions.values()]) {
      if (!session.busy && now() - session.lastActivityAt > ttlMs) {
        sessions.delete(session.id);
        await removeFileQuiet(partPath(session.id));
      }
    }
  }

  function owned(id: unknown, ownerKey: string): UploadSession {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session) throw new FileManagerError('fileManager.uploadNotFound', 404);
    if (session.ownerKey !== ownerKey) throw new FileManagerError('fileManager.uploadForbidden', 403);
    return session;
  }

  return {
    async begin(input: { ownerKey: string; rootId: string; dir: string; name: string; size: unknown; overwrite?: boolean }): Promise<UploadView> {
      await sweep();
      const size = Number(input.size);
      if (!Number.isInteger(size) || size < 0) throw fmError.invalidInput('size');
      if (size > maxTotal) throw fmError.tooLarge(maxTotal);
      const id = crypto.randomBytes(16).toString('hex');
      await createEmptyPart(partPath(id));
      const session: UploadSession = {
        id,
        ownerKey: input.ownerKey,
        rootId: input.rootId,
        dir: input.dir,
        name: input.name,
        size,
        received: 0,
        overwrite: Boolean(input.overwrite),
        busy: false,
        createdAt: now(),
        lastActivityAt: now(),
      };
      sessions.set(id, session);
      return view(session);
    },

    async status(id: unknown, ownerKey: string): Promise<UploadView> {
      await sweep();
      return view(owned(id, ownerKey));
    },

    async chunk(id: unknown, ownerKey: string, offsetRaw: unknown, chunk: unknown): Promise<UploadView> {
      const session = owned(id, ownerKey);
      if (session.busy) throw new FileManagerError('fileManager.uploadBusy', 409, null, { nextOffset: session.received });
      const offset = Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0) throw fmError.invalidInput('offset');
      if (!Buffer.isBuffer(chunk) || chunk.length === 0) throw fmError.invalidInput('chunk');
      if (chunk.length > UPLOAD_MAX_CHUNK_BYTES) throw fmError.tooLarge(UPLOAD_MAX_CHUNK_BYTES);
      if (offset !== session.received) throw new FileManagerError('fileManager.uploadOffsetMismatch', 409, null, { nextOffset: session.received });
      if (offset + chunk.length > session.size) throw new FileManagerError('fileManager.uploadExceedsSize', 413, null, { nextOffset: session.received });
      session.busy = true;
      try {
        const next = await appendPartChunk(partPath(session.id), offset, chunk);
        if (next !== offset + chunk.length) {
          session.received = Math.max(0, await partSize(partPath(session.id)));
          throw new FileManagerError('fileManager.uploadOffsetMismatch', 409, null, { nextOffset: session.received });
        }
        session.received = next;
        session.lastActivityAt = now();
        return view(session);
      } finally {
        session.busy = false;
      }
    },

    /** 完成前的核对：已收字节 = 声明大小 = 磁盘大小。返回临时文件路径（调用方落位后调用 `finish`）。 */
    async prepareComplete(id: unknown, ownerKey: string): Promise<{ session: UploadSession; partFile: string }> {
      const session = owned(id, ownerKey);
      if (session.busy) throw new FileManagerError('fileManager.uploadBusy', 409, null, { nextOffset: session.received });
      const onDisk = await partSize(partPath(session.id));
      if (session.received !== session.size || onDisk !== session.size) {
        throw new FileManagerError('fileManager.uploadIncomplete', 409, null, { nextOffset: session.received });
      }
      session.busy = true;
      return { session, partFile: partPath(session.id) };
    },

    async finish(id: string, succeeded: boolean): Promise<void> {
      const session = sessions.get(id);
      if (!session) return;
      if (succeeded) {
        sessions.delete(id);
        await removeFileQuiet(partPath(id));
      } else {
        session.busy = false;
        session.lastActivityAt = now();
      }
    },

    async abort(id: unknown, ownerKey: string): Promise<void> {
      const session = owned(id, ownerKey);
      sessions.delete(session.id);
      await removeFileQuiet(partPath(session.id));
    },

    async stopAll(): Promise<void> {
      for (const id of [...sessions.keys()]) {
        sessions.delete(id);
        await removeFileQuiet(partPath(id));
      }
    },
  };
}

export type ChunkedUploads = ReturnType<typeof createChunkedUploads>;
