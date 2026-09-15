import type { TablePreviewResult } from './tableParsing';

export type TableWorkerRequest = { id: number; kind: 'xlsx' | 'csv'; buffer: ArrayBuffer };

export type TableWorkerResponse =
  | { id: number; ok: true; result: TablePreviewResult }
  | { id: number; ok: false; error: string };

export type TableWorkerLike = {
  onmessage: ((event: MessageEvent<TableWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: TableWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
};

export class TablePreviewError extends Error {
  readonly code: 'timeout' | 'aborted' | 'failed';

  constructor(code: 'timeout' | 'aborted' | 'failed', message: string) {
    super(message);
    this.name = 'TablePreviewError';
    this.code = code;
  }
}

export const TABLE_WORKER_TIMEOUT_MS = 20_000;

let nextRequestId = 1;

/**
 * 一次解析一个 Worker：完成、失败、超时、被中止都立刻 terminate（Worker 不复用——卡在炸弹上的 Worker 必须整个丢掉）。
 * 缓冲区以 transfer 方式交出，主线程不再持有一份拷贝。
 */
export function runTablePreviewWorker(
  kind: 'xlsx' | 'csv',
  buffer: ArrayBuffer,
  options: { createWorker: () => TableWorkerLike; signal?: AbortSignal; timeoutMs?: number },
): Promise<TablePreviewResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new TablePreviewError('aborted', 'aborted'));
      return;
    }
    const id = nextRequestId++;
    const worker = options.createWorker();
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      action();
    };
    const onAbort = () => finish(() => reject(new TablePreviewError('aborted', 'aborted')));
    const timer = setTimeout(() => finish(() => reject(new TablePreviewError('timeout', 'timeout'))), options.timeoutMs ?? TABLE_WORKER_TIMEOUT_MS);
    options.signal?.addEventListener('abort', onAbort);
    worker.onmessage = (event) => {
      const data = event.data;
      if (!data || data.id !== id) return;
      finish(() => (data.ok ? resolve(data.result) : reject(new TablePreviewError('failed', data.error))));
    };
    worker.onerror = (event) => finish(() => reject(new TablePreviewError('failed', event.message || 'worker error')));
    worker.postMessage({ id, kind, buffer }, [buffer]);
  });
}

export function createTablePreviewWorker(): TableWorkerLike {
  return new Worker(new URL('./tablePreview.worker.ts', import.meta.url), { type: 'module' }) as unknown as TableWorkerLike;
}
