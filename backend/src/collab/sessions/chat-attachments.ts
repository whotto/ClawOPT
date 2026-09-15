/**
 * 外部运行时单聊的附件重绑（P1b）。
 *
 * 消息里的附件是上传接口回的 `/uploads/<随机名>` 链接。交给 CLI 之前在服务端换成真实文件：
 * - **从不信客户端给的路径**：只认这个会话在 `files` 表里登记过的上传（按存储文件名匹配、会话必须是这一个），
 *   消息里写的任何绝对路径、别的会话的上传、没登记的名字一律不重绑；
 * - 真实路径取库里的 `stored_path` 再 realpath，必须还在上传目录里、是普通文件；
 * - 图片（运行时声明了 `images`）作为原生图片输入交给适配器（base64，单张 ≤ 5 MB、最多 8 张）；
 *   所有附件另在 prompt 末尾列出本地路径，工具（读文件、看图）能直接打开。
 */
import fs from 'fs';
import path from 'path';

import type { StoredFileRow } from '../../core/db';
import { assertRegularFile } from '../../openclaw';

export const MAX_INLINE_IMAGES = 8;
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export type ResolvedAttachment = { name: string; path: string; mimeType: string; isImage: boolean };
export type AttachmentBinding = {
  prompt: string;
  images: Array<{ path: string; mimeType: string; data?: string }>;
  attachments: ResolvedAttachment[];
};

const UPLOAD_LINK = /!?\[([^\]]*)\]\((\/uploads\/([A-Za-z0-9._-]+))\)/g;

export function bindUploadedAttachments(input: {
  prompt: string;
  sessionFiles: ReadonlyArray<Pick<StoredFileRow, 'original_name' | 'mime_type' | 'stored_path'>>;
  uploadsRoot: string;
  imagesSupported: boolean;
}): AttachmentBinding {
  let root: string;
  try {
    root = fs.realpathSync(input.uploadsRoot);
  } catch {
    return { prompt: input.prompt, images: [], attachments: [] };
  }
  const byStoredName = new Map(input.sessionFiles.map((file) => [path.basename(file.stored_path), file]));
  const attachments: ResolvedAttachment[] = [];
  const seen = new Set<string>();
  for (const match of input.prompt.matchAll(UPLOAD_LINK)) {
    const storedName = match[3];
    if (seen.has(storedName)) continue;
    seen.add(storedName);
    const row = byStoredName.get(storedName);
    if (!row) continue;
    let real: string;
    try {
      real = fs.realpathSync(row.stored_path);
      // 路径是库里存的（数据给的）：读之前判普通文件，不跟命名管道 / 目录较劲。
      assertRegularFile(real);
    } catch {
      continue;
    }
    if (real !== path.join(root, path.basename(real)) && !real.startsWith(`${root}${path.sep}`)) continue;
    const mimeType = row.mime_type || 'application/octet-stream';
    attachments.push({ name: row.original_name || match[1] || storedName, path: real, mimeType, isImage: mimeType.startsWith('image/') });
  }
  if (attachments.length === 0) return { prompt: input.prompt, images: [], attachments };

  const images: AttachmentBinding['images'] = [];
  if (input.imagesSupported) {
    for (const attachment of attachments.filter((item) => item.isImage).slice(0, MAX_INLINE_IMAGES)) {
      try {
        const small = fs.statSync(attachment.path).size <= MAX_INLINE_IMAGE_BYTES;
        images.push(small
          ? { path: attachment.path, mimeType: attachment.mimeType, data: fs.readFileSync(attachment.path).toString('base64') }
          : { path: attachment.path, mimeType: attachment.mimeType });
      } catch {
        // 读不了就只给路径。
      }
    }
  }
  const lines = attachments.map((item) => `- ${item.name}: ${item.path}`);
  return {
    prompt: `${input.prompt}\n\nAttached files (local paths):\n${lines.join('\n')}`,
    images,
    attachments,
  };
}
