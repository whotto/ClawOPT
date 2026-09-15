/**
 * P1b 附件重绑：只认本会话登记过的上传、realpath 必须在上传目录里、不信消息里的路径；图片按能力内联。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindUploadedAttachments } from '../src/collab/sessions/chat-attachments';

let root: string;
let uploads: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-attach-'));
  uploads = path.join(root, 'uploads');
  fs.mkdirSync(uploads);
  outside = path.join(root, 'secret.txt');
  fs.writeFileSync(path.join(uploads, 'abc123.png'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(uploads, 'doc999.pdf'), 'pdf');
  fs.writeFileSync(outside, 'top secret');
  fs.symlinkSync(outside, path.join(uploads, 'link000.txt'));
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('bindUploadedAttachments', () => {
  it('本会话登记过的上传换成真实路径；图片内联 base64；未登记 / 别的会话 / 绝对路径不重绑', () => {
    const binding = bindUploadedAttachments({
      prompt: 'look ![shot.png](/uploads/abc123.png) and [report.pdf](/uploads/doc999.pdf) and [x](/uploads/unknown.png) /etc/passwd',
      sessionFiles: [
        { original_name: 'shot.png', mime_type: 'image/png', stored_path: path.join(uploads, 'abc123.png') },
        { original_name: 'report.pdf', mime_type: 'application/pdf', stored_path: path.join(uploads, 'doc999.pdf') },
      ],
      uploadsRoots: [uploads],
      imagesSupported: true,
    });
    expect(binding.attachments.map((a) => a.name)).toEqual(['shot.png', 'report.pdf']);
    expect(binding.images).toEqual([{ path: fs.realpathSync(path.join(uploads, 'abc123.png')), mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }]);
    expect(binding.prompt).toContain(`- report.pdf: ${fs.realpathSync(path.join(uploads, 'doc999.pdf'))}`);
    expect(binding.prompt).not.toContain('unknown.png:');
  });

  it('登记行指向上传目录外（软链到外面）：不重绑；运行时不支持图片时只给路径', () => {
    const binding = bindUploadedAttachments({
      prompt: '[a](/uploads/link000.txt) ![b](/uploads/abc123.png)',
      sessionFiles: [
        { original_name: 'a', mime_type: 'text/plain', stored_path: path.join(uploads, 'link000.txt') },
        { original_name: 'b', mime_type: 'image/png', stored_path: path.join(uploads, 'abc123.png') },
      ],
      uploadsRoots: [uploads],
      imagesSupported: false,
    });
    expect(binding.attachments.map((a) => a.name)).toEqual(['b']);
    expect(binding.images).toEqual([]);
    expect(binding.prompt).not.toContain('secret');
  });

  it('没有附件：原样', () => {
    expect(bindUploadedAttachments({ prompt: 'hi', sessionFiles: [], uploadsRoots: [uploads], imagesSupported: true })).toEqual({ prompt: 'hi', images: [], attachments: [] });
  });
});
