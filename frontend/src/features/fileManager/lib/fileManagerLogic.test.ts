import { describe, expect, it } from 'vitest';
import { breadcrumbs, formatBytes, groupRoots, isValidEntryName, joinPath, parentPath, runChunkedUpload, type UploadApi } from './fileManagerLogic';

describe('路径小工具', () => {
  it('拼接、父目录、面包屑', () => {
    expect(joinPath('', 'a')).toBe('a');
    expect(joinPath('a/b', 'c')).toBe('a/b/c');
    expect(parentPath('a/b/c')).toBe('a/b');
    expect(parentPath('a')).toBe('');
    expect(breadcrumbs('a/b')).toEqual([{ label: 'a', path: 'a' }, { label: 'b', path: 'a/b' }]);
  });

  it('文件名校验与后端同判据', () => {
    expect(isValidEntryName('ok.txt')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x\ny']) expect(isValidEntryName(bad)).toBe(false);
  });

  it('大小与根分组', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    const roots = groupRoots([
      { id: 'ssh:1', kind: 'ssh', label: 's', backend: 'ssh', writable: true, available: false, reasonCode: 'host.sshMissing' },
      { id: 'agent:a', kind: 'agent', label: 'a', backend: 'local', writable: false, available: true, reasonCode: null },
    ]);
    expect(roots.map((group) => group.group)).toEqual(['agents', 'remote']);
  });
});

/** 模拟服务端：严格偏移，可以在第 n 块时「断线」。 */
function fakeServer(options: { failAtChunk?: number; maxChunkBytes?: number } = {}) {
  const received: number[] = [];
  let size = 0;
  let offset = 0;
  let calls = 0;
  let completed = false;
  const view = () => ({ id: 'u1', nextOffset: offset, size, maxChunkBytes: options.maxChunkBytes ?? 4 });
  const api: UploadApi = {
    begin: async (input) => { size = input.size; offset = 0; return { ok: true, status: 200, upload: view() }; },
    status: async (id) => (id === 'u1' ? { ok: true, status: 200, upload: view() } : { ok: false, status: 404 }),
    chunk: async (_id, at, chunk) => {
      calls += 1;
      if (options.failAtChunk === calls) throw new Error('network');
      if (at !== offset) return { ok: false, status: 409, nextOffset: offset, errorCode: 'fileManager.uploadOffsetMismatch' };
      offset += chunk.size;
      received.push(chunk.size);
      return { ok: true, status: 200, upload: view() };
    },
    complete: async () => { completed = offset === size; return completed ? { ok: true, status: 200 } : { ok: false, status: 409 }; },
  };
  return { api, received, get completed() { return completed; }, get offset() { return offset; } };
}

describe('分块上传驱动', () => {
  it('按服务端给的块大小切，传完再 complete', async () => {
    const server = fakeServer();
    const progress: number[] = [];
    const outcome = await runChunkedUpload({ api: server.api, file: new Blob(['0123456789']), root: 'agent:a', dir: '', name: 'x', onProgress: (p) => progress.push(p.sent) });
    expect(outcome).toEqual({ kind: 'done' });
    expect(server.received).toEqual([4, 4, 2]);
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(server.completed).toBe(true);
  });

  it('中途断线：交回会话 id；带 resumeId 重试从服务端的偏移接着传，不从头来', async () => {
    const server = fakeServer({ failAtChunk: 2 });
    const first = await runChunkedUpload({ api: server.api, file: new Blob(['0123456789']), root: 'agent:a', dir: '', name: 'x' });
    expect(first).toMatchObject({ kind: 'failed', uploadId: 'u1', sent: 4 });
    const second = await runChunkedUpload({ api: server.api, file: new Blob(['0123456789']), root: 'agent:a', dir: '', name: 'x', resumeId: 'u1' });
    expect(second).toEqual({ kind: 'done' });
    expect(server.received).toEqual([4, 4, 2]);
  });
});
