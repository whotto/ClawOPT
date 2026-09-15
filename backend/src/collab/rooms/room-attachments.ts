/**
 * 群附件（spec 02 F18）：配额、限流、可续传分块上传、服务端路径重绑、Agent 发布附件。
 *
 * ## 上限
 *
 * 单文件 20 MB；每群合计 500 MB；每群每 60 秒 30 次上传（限流表有界，10k 个键）；分块 256 KB；上传会话空闲 5 分钟过期。
 *
 * ## 可续传
 *
 * 开会话 → 按 `offset` 顺序 PUT 分块（offset 必须等于已收字节数，断线后先 GET 状态再从已收处续传）→ complete（可带 sha256 复核）→ 落定。
 * 会话绑定发起人（账号用户 / 访客），别人拿到 uploadId 也续不了。临时文件在群上传目录下的 `.partial/`，过期或中止即删。
 *
 * ## 路径重绑（服务端不信任客户端给的路径）
 *
 * 消息里只认 `/uploads/<存储名>` 形状的引用；每个存储名必须登记在**这个群**名下（`room_attachments`，或旧上传接口登记在 `files` 表的这个群），
 * 且磁盘上是群上传目录里的普通文件（不是软链接）。对不上整条消息 400 `groups.attachmentInvalid`。
 * Agent 拿到的是服务端按存储名解析出的绝对路径（网关路径的上传链接改写本来就只认上传目录）。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

import type { RoomMessageAttachment } from './room-message-store';
import type { RoomActor } from './room-policy';
import { applyRoomSchema } from './room-schema';
import { readRegularFile, writeFileAtomic } from './room-workspace';

export const ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_MAX_ROOM_BYTES = 500 * 1024 * 1024;
export const ATTACHMENT_RATE_LIMIT = 30;
export const ATTACHMENT_RATE_WINDOW_MS = 60_000;
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export const ATTACHMENT_SESSION_TTL_MS = 5 * 60_000;
const RATE_MAP_MAX_KEYS = 10_000;
const STORED_NAME = /^[0-9a-f]{32}(\.[a-z0-9]{1,10})?$/;
const UPLOAD_REF = /\/uploads\/([^\s)"'<>\]]+)/g;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export class AttachmentError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'AttachmentError';
  }
}

export function safeExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

export function mediaTypeFor(name: string, declared?: string): string {
  const ext = safeExtension(name);
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
  };
  if (map[ext]) return map[ext];
  return typeof declared === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(declared) && !/html|javascript|svg/i.test(declared) ? declared : 'application/octet-stream';
}

type UploadSession = {
  id: string;
  groupId: string;
  owner: string;
  name: string;
  mediaType: string;
  size: number;
  received: number;
  tempPath: string;
  hash: crypto.Hash;
  lastActivity: number;
};

export type RoomAttachmentsDeps = {
  conn: Database.Database;
  uploadsDir: (groupId: string) => string;
  /** 旧上传接口在 `files` 表里的登记（按存储路径查会话键）。 */
  legacyUploadOwner?: (storedPath: string) => string | null;
  /** 登记到 `files` 表（上传记录列表、文件归属授权沿用它）。 */
  registerFile?: (input: { groupId: string; originalName: string; mimeType: string; size: number; storedPath: string }) => void;
  now?: () => number;
};

function actorKey(actor: RoomActor): string {
  return actor.kind === 'user' ? `user:${actor.userId ?? 'owner'}` : `guest:${actor.guestId}`;
}

export function createRoomAttachments(deps: RoomAttachmentsDeps) {
  const { conn } = deps;
  applyRoomSchema(conn);
  const now = deps.now ?? Date.now;
  const sessions = new Map<string, UploadSession>();
  const rate = new Map<string, number[]>();

  function roomUsage(groupId: string): number {
    const row = conn.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM room_attachments WHERE group_id = ?').get(groupId) as { total: number };
    const pending = [...sessions.values()].filter((session) => session.groupId === groupId).reduce((sum, session) => sum + session.size, 0);
    return row.total + pending;
  }

  function takeRate(groupId: string): void {
    const t = now();
    const hits = (rate.get(groupId) ?? []).filter((at) => t - at < ATTACHMENT_RATE_WINDOW_MS);
    if (hits.length >= ATTACHMENT_RATE_LIMIT) throw new AttachmentError(429, 'groups.attachmentRateLimited');
    hits.push(t);
    rate.delete(groupId);
    rate.set(groupId, hits);
    while (rate.size > RATE_MAP_MAX_KEYS) rate.delete(rate.keys().next().value as string);
  }

  function assertQuota(groupId: string, size: number): void {
    if (!Number.isInteger(size) || size <= 0) throw new AttachmentError(400, 'groups.attachmentInvalid', 'size must be a positive integer');
    if (size > ATTACHMENT_MAX_FILE_BYTES) throw new AttachmentError(413, 'groups.attachmentTooLarge');
    if (roomUsage(groupId) + size > ATTACHMENT_MAX_ROOM_BYTES) throw new AttachmentError(413, 'groups.attachmentQuotaExceeded');
  }

  function sweep(): void {
    const t = now();
    for (const session of [...sessions.values()]) {
      if (t - session.lastActivity > ATTACHMENT_SESSION_TTL_MS) abortSession(session);
    }
  }

  function abortSession(session: UploadSession): void {
    sessions.delete(session.id);
    fs.rmSync(session.tempPath, { force: true });
  }

  function requireSession(groupId: string, uploadId: string, actor: RoomActor): UploadSession {
    sweep();
    const session = sessions.get(uploadId);
    if (!session || session.groupId !== groupId || session.owner !== actorKey(actor)) throw new AttachmentError(404, 'groups.attachmentUploadNotFound');
    return session;
  }

  function openUpload(groupId: string, actor: RoomActor, input: { name: unknown; size: unknown; mediaType?: unknown }) {
    sweep();
    const name = typeof input.name === 'string' ? input.name.replace(/[\\/\0]/g, '_').slice(0, 200).trim() : '';
    if (!name) throw new AttachmentError(400, 'groups.attachmentInvalid', 'name is required');
    const size = Number(input.size);
    assertQuota(groupId, size);
    takeRate(groupId);
    const id = crypto.randomUUID();
    const partialDir = path.join(deps.uploadsDir(groupId), '.partial');
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(partialDir, id);
    const session: UploadSession = {
      id, groupId, owner: actorKey(actor), name, mediaType: mediaTypeFor(name, typeof input.mediaType === 'string' ? input.mediaType : undefined),
      size, received: 0, tempPath, hash: crypto.createHash('sha256'), lastActivity: now(),
    };
    sessions.set(id, session);
    return { uploadId: id, chunkSize: ATTACHMENT_CHUNK_BYTES, received: 0, size };
  }

  function status(groupId: string, uploadId: string, actor: RoomActor) {
    const session = requireSession(groupId, uploadId, actor);
    return { uploadId, received: session.received, size: session.size, chunkSize: ATTACHMENT_CHUNK_BYTES };
  }

  function appendChunk(groupId: string, uploadId: string, actor: RoomActor, offset: number, chunk: Buffer) {
    const session = requireSession(groupId, uploadId, actor);
    if (!Number.isInteger(offset) || offset !== session.received) throw new AttachmentError(409, 'groups.attachmentOffsetMismatch', `expected offset ${session.received}`);
    if (chunk.length === 0 || chunk.length > ATTACHMENT_CHUNK_BYTES) throw new AttachmentError(400, 'groups.attachmentChunkInvalid');
    if (session.received + chunk.length > session.size) throw new AttachmentError(400, 'groups.attachmentChunkInvalid', 'chunk exceeds declared size');
    // 分块追加是这里唯一的写调用点（群上传目录下的 .partial/<uploadId>，路径由服务端生成）。
    fs.appendFileSync(session.tempPath, chunk, { mode: 0o600 });
    session.hash.update(chunk);
    session.received += chunk.length;
    session.lastActivity = now();
    return { uploadId, received: session.received, size: session.size };
  }

  function complete(groupId: string, uploadId: string, actor: RoomActor, expectedSha256?: unknown): RoomMessageAttachment {
    const session = requireSession(groupId, uploadId, actor);
    if (session.received !== session.size) throw new AttachmentError(409, 'groups.attachmentIncomplete');
    const digest = session.hash.digest('hex');
    if (typeof expectedSha256 === 'string' && expectedSha256 && expectedSha256 !== digest) {
      abortSession(session);
      throw new AttachmentError(409, 'groups.attachmentHashMismatch');
    }
    // 配额在开会话时已经按声明大小预占（roomUsage 把进行中的会话算进去），这里不再重复判。
    sessions.delete(session.id);
    return commitFile({ groupId, tempPath: session.tempPath, name: session.name, mediaType: session.mediaType, size: session.size, sha256: digest, uploader: actor, memberId: null });
  }

  function commitFile(input: { groupId: string; tempPath: string; name: string; mediaType: string; size: number; sha256: string; uploader: RoomActor | null; memberId: string | null }): RoomMessageAttachment {
    const storedName = `${crypto.randomBytes(16).toString('hex')}${safeExtension(input.name)}`;
    const dir = deps.uploadsDir(input.groupId);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, storedName);
    fs.renameSync(input.tempPath, finalPath);
    fs.chmodSync(finalPath, 0o600);
    const id = crypto.randomUUID();
    conn.prepare(`INSERT INTO room_attachments (id, group_id, stored_name, original_name, media_type, size, sha256, uploader_kind, uploader_user_id, uploader_guest_id, uploader_member_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.groupId, storedName, input.name, input.mediaType, input.size, input.sha256,
      input.uploader ? input.uploader.kind : 'agent',
      input.uploader?.kind === 'user' ? input.uploader.userId : null,
      input.uploader?.kind === 'guest' ? input.uploader.guestId : null,
      input.memberId, now(),
    );
    deps.registerFile?.({ groupId: input.groupId, originalName: input.name, mimeType: input.mediaType, size: input.size, storedPath: finalPath });
    return { id, name: input.name, mediaType: input.mediaType, size: input.size, url: `/uploads/${storedName}`, kind: IMAGE_EXT.has(safeExtension(input.name)) ? 'image' : 'file' };
  }

  function abort(groupId: string, uploadId: string, actor: RoomActor): void {
    abortSession(requireSession(groupId, uploadId, actor));
  }

  /**
   * 消息里的上传引用重绑：每个 `/uploads/<名>` 都必须属于这个群且是群上传目录里的普通文件。
   * 返回原文与引用到的附件（写进消息元数据）。
   */
  function rebind(groupId: string, content: string): { content: string; attachments: RoomMessageAttachment[] } {
    const attachments: RoomMessageAttachment[] = [];
    const seen = new Set<string>();
    for (const match of content.matchAll(UPLOAD_REF)) {
      let name: string;
      try {
        name = decodeURIComponent(match[1]);
      } catch {
        throw new AttachmentError(400, 'groups.attachmentInvalid', 'malformed upload reference');
      }
      if (seen.has(name)) continue;
      seen.add(name);
      if (name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new AttachmentError(400, 'groups.attachmentInvalid', 'upload reference must be a stored name');
      const dir = deps.uploadsDir(groupId);
      const abs = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        throw new AttachmentError(400, 'groups.attachmentInvalid', 'upload not found in this room');
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AttachmentError(400, 'groups.attachmentInvalid', 'upload is not a regular file');
      const row = STORED_NAME.test(name)
        ? conn.prepare('SELECT * FROM room_attachments WHERE stored_name = ? AND group_id = ?').get(name, groupId) as Record<string, any> | undefined
        : undefined;
      if (row) {
        attachments.push({ id: row.id, name: row.original_name, mediaType: row.media_type, size: row.size, url: `/uploads/${name}`, kind: IMAGE_EXT.has(safeExtension(name)) ? 'image' : 'file' });
        continue;
      }
      // 旧上传接口（/api/files/upload）登记在 files 表：会话键必须是这个群。
      if (deps.legacyUploadOwner?.(abs) === groupId) continue;
      throw new AttachmentError(400, 'groups.attachmentInvalid', 'upload does not belong to this room');
    }
    return { content, attachments };
  }

  /** 旧上传接口的群上传：同样的单文件、配额与限流上限（超了由调用方删文件回 413 / 429）。 */
  function admitLegacyUpload(groupId: string, sizes: number[]): void {
    for (const size of sizes) {
      if (size > ATTACHMENT_MAX_FILE_BYTES) throw new AttachmentError(413, 'groups.attachmentTooLarge');
    }
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (roomUsage(groupId) + total > ATTACHMENT_MAX_ROOM_BYTES) throw new AttachmentError(413, 'groups.attachmentQuotaExceeded');
    takeRate(groupId);
  }

  /** Agent 发布附件：从工作区里的一个文件复制进群上传目录（受单文件与配额上限）。 */
  function publishFromWorkspace(input: { groupId: string; memberId: string; absolutePath: string; name: string }): RoomMessageAttachment {
    const stat = fs.lstatSync(input.absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AttachmentError(400, 'groups.attachmentInvalid');
    assertQuota(input.groupId, stat.size);
    const partialDir = path.join(deps.uploadsDir(input.groupId), '.partial');
    fs.mkdirSync(partialDir, { recursive: true, mode: 0o700 });
    const tempPath = path.join(partialDir, crypto.randomUUID());
    // 读写都经群工作区唯一的读写入口（普通文件判定、原子写）。
    const buffer = readRegularFile(input.absolutePath);
    writeFileAtomic(tempPath, `${tempPath}.tmp`, buffer);
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    return commitFile({ groupId: input.groupId, tempPath, name: input.name, mediaType: mediaTypeFor(input.name), size: stat.size, sha256: sha, uploader: null, memberId: input.memberId });
  }

  function deleteForGroup(groupId: string): void {
    for (const session of [...sessions.values()].filter((item) => item.groupId === groupId)) abortSession(session);
    conn.prepare('DELETE FROM room_attachments WHERE group_id = ?').run(groupId);
  }

  return { openUpload, status, appendChunk, complete, abort, rebind, admitLegacyUpload, publishFromWorkspace, roomUsage, deleteForGroup, sweep };
}

export type RoomAttachments = ReturnType<typeof createRoomAttachments>;
