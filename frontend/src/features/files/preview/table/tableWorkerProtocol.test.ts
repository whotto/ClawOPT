import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTablePreviewWorker, TablePreviewError, type TableWorkerLike, type TableWorkerRequest } from './tableWorkerProtocol';

function fakeWorker() {
  const worker: TableWorkerLike & { posted: TableWorkerRequest[]; terminated: number } = {
    onmessage: null,
    onerror: null,
    posted: [],
    terminated: 0,
    postMessage(message) { this.posted.push(message); },
    terminate() { this.terminated += 1; },
  };
  return worker;
}

const result = { sheets: [], totalSheets: 0, sheetsTruncated: false };

afterEach(() => vi.useRealTimers());

describe('runTablePreviewWorker', () => {
  it('resolves with the matching response and terminates the worker', async () => {
    const worker = fakeWorker();
    const promise = runTablePreviewWorker('csv', new ArrayBuffer(4), { createWorker: () => worker });
    const { id } = worker.posted[0];
    worker.onmessage?.({ data: { id: id + 999, ok: true, result: { ...result, totalSheets: 7 } } } as MessageEvent);
    worker.onmessage?.({ data: { id, ok: true, result } } as MessageEvent);
    await expect(promise).resolves.toEqual(result);
    expect(worker.terminated).toBe(1);
  });

  it('times out and terminates a stuck worker', async () => {
    vi.useFakeTimers();
    const worker = fakeWorker();
    const promise = runTablePreviewWorker('xlsx', new ArrayBuffer(4), { createWorker: () => worker, timeoutMs: 50 });
    vi.advanceTimersByTime(60);
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
    expect(worker.terminated).toBe(1);
  });

  it('aborting (file switched / preview closed) terminates the worker', async () => {
    const worker = fakeWorker();
    const controller = new AbortController();
    const promise = runTablePreviewWorker('xlsx', new ArrayBuffer(4), { createWorker: () => worker, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(TablePreviewError);
    expect(worker.terminated).toBe(1);
    // 迟到的结果不再生效。
    worker.onmessage?.({ data: { id: 1, ok: true, result } } as MessageEvent);
  });

  it('maps worker-side failures', async () => {
    const worker = fakeWorker();
    const promise = runTablePreviewWorker('xlsx', new ArrayBuffer(4), { createWorker: () => worker });
    worker.onmessage?.({ data: { id: worker.posted[0].id, ok: false, error: 'bad file' } } as MessageEvent);
    await expect(promise).rejects.toMatchObject({ code: 'failed', message: 'bad file' });
  });
});
