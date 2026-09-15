/**
 * 群附件的可续传分块上传（P3 任务 8；服务端 room-attachments.ts：分块 256 KB、按 offset 顺序追加、完成时核 SHA-256）。
 *
 * 流程：open → 逐块 PUT（offset = 已收字节）→ 某块失败时 GET 状态，从服务端已收处续传（最多重试 N 次）→ complete(sha256)。
 * 传输层注入（群聊页用登录 cookie，访客页带访客令牌头），便于测。
 */
export type UploadTransport = {
  open(input: { name: string; size: number; mediaType: string }): Promise<{ uploadId: string; chunkSize: number; received: number }>;
  status(uploadId: string): Promise<{ received: number }>;
  put(uploadId: string, offset: number, chunk: Blob): Promise<{ received: number }>;
  complete(uploadId: string, sha256: string): Promise<{ id: string; name: string; url: string; mediaType: string; size: number; kind: 'image' | 'file' }>;
  abort?(uploadId: string): Promise<void>;
};

export class UploadFailedError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function uploadInChunks(
  file: Blob & { name?: string; type?: string },
  transport: UploadTransport,
  options: { maxRetries?: number; onProgress?: (received: number, total: number) => void; signal?: AbortSignal } = {},
) {
  const maxRetries = options.maxRetries ?? 3;
  const name = file.name || 'file';
  const opened = await transport.open({ name, size: file.size, mediaType: file.type || 'application/octet-stream' });
  const hash = sha256Hex(file);
  let received = opened.received;
  let failures = 0;
  while (received < file.size) {
    if (options.signal?.aborted) {
      await transport.abort?.(opened.uploadId).catch(() => {});
      throw new UploadFailedError('upload.aborted');
    }
    const chunk = file.slice(received, Math.min(file.size, received + opened.chunkSize));
    try {
      received = (await transport.put(opened.uploadId, received, chunk)).received;
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures > maxRetries) throw error instanceof UploadFailedError ? error : new UploadFailedError('upload.chunkFailed', (error as Error)?.message);
      // 续传：以服务端记的已收字节为准（可能那一块其实到了）。
      received = (await transport.status(opened.uploadId)).received;
    }
    options.onProgress?.(received, file.size);
  }
  return transport.complete(opened.uploadId, await hash);
}

/** 基于 fetch 的传输：`base` 形如 `/api/groups/<id>/attachments/uploads` 或 `/api/share/rooms/<code>/uploads`。 */
export function fetchUploadTransport(base: string, headers: Record<string, string> = {}): UploadTransport {
  const json = async (response: Response) => {
    const body = await response.json().catch(() => null) as any;
    if (!response.ok || !body?.success) throw new UploadFailedError(body?.errorCode || 'upload.failed', body?.errorDetail || body?.error);
    return body;
  };
  return {
    open: async (input) => json(await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) })),
    status: async (uploadId) => json(await fetch(`${base}/${encodeURIComponent(uploadId)}`, { headers })),
    put: async (uploadId, offset, chunk) => json(await fetch(`${base}/${encodeURIComponent(uploadId)}?offset=${offset}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...headers }, body: chunk })),
    complete: async (uploadId, sha256) => (await json(await fetch(`${base}/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sha256 }) }))).attachment,
    abort: async (uploadId) => { await fetch(`${base}/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers }); },
  };
}
