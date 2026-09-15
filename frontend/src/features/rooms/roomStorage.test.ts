import { describe, expect, it } from 'vitest';

import { uploadInChunks, type UploadTransport } from './chunkedUpload';
import { loadRoomDraft, ROOM_DRAFT_TTL_MS, roomQueueCapability, saveRoomDraft, sweepRoomDrafts } from './roomStorage';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

describe('每群草稿', () => {
  it('按群存取、带 @ 区间；空文本即清；30 天过期', () => {
    const storage = memoryStorage();
    saveRoomDraft('g1', '@主程 草稿', [{ start: 0, end: 3, memberId: 'm', name: '主程' }], 1000, storage);
    saveRoomDraft('g2', '另一个群', [], 1000, storage);
    expect(loadRoomDraft('g1', 2000, storage)).toMatchObject({ text: '@主程 草稿', ranges: [{ memberId: 'm' }] });
    expect(loadRoomDraft('g2', 2000, storage)?.text).toBe('另一个群');
    saveRoomDraft('g2', '   ', [], 3000, storage);
    expect(loadRoomDraft('g2', 3000, storage)).toBeNull();
    expect(loadRoomDraft('g1', 1000 + ROOM_DRAFT_TTL_MS + 1, storage)).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it('sweep 清掉过期的；坏 JSON 不抛', () => {
    const storage = memoryStorage();
    saveRoomDraft('old', 'x', [], 0, storage);
    saveRoomDraft('new', 'y', [], ROOM_DRAFT_TTL_MS, storage);
    storage.setItem('clawopt.room.draft.bad', '{');
    expect(sweepRoomDrafts(ROOM_DRAFT_TTL_MS + 10, storage)).toBe(2);
    expect(loadRoomDraft('new', ROOM_DRAFT_TTL_MS + 10, storage)?.text).toBe('y');
  });

  it('排队能力令牌：每群一枚、稳定、48 位十六进制', () => {
    const storage = memoryStorage();
    const a = roomQueueCapability('g1', storage);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(roomQueueCapability('g1', storage)).toBe(a);
    expect(roomQueueCapability('g2', storage)).not.toBe(a);
  });
});

describe('分块上传', () => {
  function fakeServer(options: { failAt?: number; failTimes?: number; ackBeforeFail?: boolean } = {}) {
    let stored = new Uint8Array(0);
    let failures = 0;
    const calls: string[] = [];
    const transport: UploadTransport = {
      open: async ({ size }) => { calls.push(`open:${size}`); return { uploadId: 'u1', chunkSize: 4, received: 0 }; },
      status: async () => { calls.push(`status:${stored.length}`); return { received: stored.length }; },
      put: async (_id, offset, chunk) => {
        if (offset !== stored.length) throw new Error('offset mismatch');
        const bytes = new Uint8Array(await chunk.arrayBuffer());
        if (options.failAt === offset && failures < (options.failTimes ?? 1)) {
          failures += 1;
          if (options.ackBeforeFail) stored = new Uint8Array([...stored, ...bytes]);
          calls.push(`fail:${offset}`);
          throw new Error('network');
        }
        stored = new Uint8Array([...stored, ...bytes]);
        calls.push(`put:${offset}`);
        return { received: stored.length };
      },
      complete: async (_id, sha) => { calls.push(`complete:${sha.slice(0, 8)}`); return { id: 'a', name: 'f', url: '/uploads/x', mediaType: 'text/plain', size: stored.length, kind: 'file' }; },
    };
    return { transport, calls, stored: () => new TextDecoder().decode(stored) };
  }

  it('按块顺序 PUT，完成时带整文件 SHA-256', async () => {
    const server = fakeServer();
    const result = await uploadInChunks(new Blob(['hello world']), server.transport);
    expect(server.stored()).toBe('hello world');
    expect(server.calls).toEqual(['open:11', 'put:0', 'put:4', 'put:8', 'complete:b94d27b9']);
    expect(result.size).toBe(11);
  });

  it('某块失败：以服务端已收为准续传（那一块其实到了也不重复写）', async () => {
    const server = fakeServer({ failAt: 4, ackBeforeFail: true });
    await uploadInChunks(new Blob(['hello world']), server.transport);
    expect(server.stored()).toBe('hello world');
    expect(server.calls).toContain('status:8');
  });

  it('连续失败超过重试上限：抛错、不 complete', async () => {
    const server = fakeServer({ failAt: 0, failTimes: 10 });
    await expect(uploadInChunks(new Blob(['abc']), server.transport, { maxRetries: 2 })).rejects.toThrow();
    expect(server.calls.some((call) => call.startsWith('complete'))).toBe(false);
  });
});
