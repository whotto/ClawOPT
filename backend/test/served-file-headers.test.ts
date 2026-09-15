/**
 * 按路径出文件的响应头：nosniff、不缓存、安全的 Content-Disposition、会执行的类型带 CSP sandbox。
 * 覆盖 download / preview / preview-data / html-preview（路径与上传两种形态）/ `/uploads` / `/openclaw`。
 * 登录未开启（隐式 super_admin），这里只看头，授权矩阵在 files-acl。
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ACTIVE_CONTENT_CSP, buildContentDisposition } from '../src/workspace/files/served-file-headers';
import { startAppHarness, type AppHarness } from './helpers/app-harness';

let h: AppHarness;
const files: Record<string, string> = {};
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const b64url = (value: string) => b64(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h = await startAppHarness();
  const openclaw = path.join(h.home, '.openclaw');
  const uploads = path.join(h.home, '.clawopt-test', 'uploads');
  const write = (key: string, file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    files[key] = file;
  };
  write('html', path.join(openclaw, 'workspace-main', 'output', 'report.html'), '<script>alert(1)</script><p>x</p>');
  write('text', path.join(openclaw, 'workspace-main', 'output', '报告 "final".txt'), '<html><script>alert(1)</script></html>');
  write('upload', path.join(uploads, '9-page.html'), '<p>up</p>');
});

afterAll(async () => {
  await h?.close();
  vi.restoreAllMocks();
});

async function head(url: string) {
  const response = await fetch(`${h.baseUrl}${url}`);
  await response.arrayBuffer();
  return response;
}

function expectNoSniffNoStore(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('出文件接口的响应头', () => {
  it('download：nosniff + no-store + ASCII 兜底与 RFC 5987 文件名；HTML 带 CSP sandbox', async () => {
    const html = await head(`/api/files/download?path=${encodeURIComponent(b64(files.html))}`);
    expectNoSniffNoStore(html);
    expect(html.headers.get('content-disposition')).toBe(`attachment; filename="report.html"; filename*=UTF-8''report.html`);
    expect(html.headers.get('content-security-policy')).toBe(ACTIVE_CONTENT_CSP);

    const text = await head(`/api/files/download?path=${encodeURIComponent(b64(files.text))}&disposition=inline`);
    expectNoSniffNoStore(text);
    expect(text.headers.get('content-disposition')).toBe(`inline; filename="__ _final_.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%22final%22.txt`);
    expect(text.headers.get('content-security-policy')).toBeNull();
  });

  it('preview（源文件）与 preview-data', async () => {
    const preview = await head(`/api/files/preview?path=${encodeURIComponent(b64(files.html))}&mode=source`);
    expectNoSniffNoStore(preview);
    expect(preview.headers.get('content-disposition')).toMatch(/^inline; filename="report.html"/);
    expect(preview.headers.get('content-security-policy')).toBe(ACTIVE_CONTENT_CSP);

    const data = await head(`/api/files/preview-data?path=${encodeURIComponent(b64(files.html))}&mode=source`);
    expectNoSniffNoStore(data);
  });

  it('html-preview：路径形态与上传形态', async () => {
    const byPath = await head(`/api/files/html-preview/path/${b64url(files.html)}/__claw_preview_root__/report.html`);
    expectNoSniffNoStore(byPath);
    expect(byPath.headers.get('content-security-policy')).toBe(ACTIVE_CONTENT_CSP);

    h.ctx.db.saveFile({ sessionKey: 'main', originalName: 'page.html', storedPath: files.upload });
    const byUpload = await head(`/api/files/html-preview/upload/9-page.html/__claw_preview_root__/9-page.html`);
    expectNoSniffNoStore(byUpload);
    expect(byUpload.headers.get('content-security-policy')).toBe(ACTIVE_CONTENT_CSP);
  });

  it('/uploads 与 /openclaw：nosniff + private no-cache；HTML 带 CSP sandbox', async () => {
    for (const url of ['/uploads/9-page.html', '/openclaw/workspace-main/output/report.html']) {
      const response = await head(url);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('private, no-cache');
      expect(response.headers.get('content-security-policy')).toBe(ACTIVE_CONTENT_CSP);
    }
  });
});

describe('buildContentDisposition', () => {
  it('引号、反斜杠、控制字符与非 ASCII 字符不拆坏头部', () => {
    expect(buildContentDisposition('attachment', 'a"b\\c\r\nd.txt')).toBe(`attachment; filename="a_b_c__d.txt"; filename*=UTF-8''a%22b%5Cc%0D%0Ad.txt`);
    expect(buildContentDisposition('inline', "it's (1)*.md")).toBe(`inline; filename="it's (1)*.md"; filename*=UTF-8''it%27s%20%281%29%2A.md`);
    expect(buildContentDisposition('inline', '中文')).toBe(`inline; filename="__"; filename*=UTF-8''%E4%B8%AD%E6%96%87`);
  });
});
