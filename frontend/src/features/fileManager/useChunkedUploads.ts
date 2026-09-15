// 上传队列：每个文件一条，按服务端的块大小分块传；失败保留会话 id，「继续上传」从服务端记下的偏移接着传。
import { useCallback, useRef, useState } from 'react';
import { fileManagerApi } from '../../api/fileManager';
import { runChunkedUpload, type UploadApi, type UploadSessionView } from './lib/fileManagerLogic';

export type UploadItem = {
  key: string;
  file: File;
  root: string;
  dir: string;
  sent: number;
  state: 'uploading' | 'failed' | 'done';
  uploadId: string | null;
  errorCode: string | null;
};

async function json(response: Response): Promise<any> {
  return response.json().catch(() => ({}));
}

const api: UploadApi = {
  async begin(input) {
    const response = await fileManagerApi.beginUpload(input);
    const body = await json(response);
    return { ok: response.ok, status: response.status, upload: body.upload as UploadSessionView | undefined, errorCode: body.errorCode };
  },
  async status(uploadId) {
    const response = await fileManagerApi.uploadStatus(uploadId);
    const body = await json(response);
    return { ok: response.ok, status: response.status, upload: body.upload };
  },
  async chunk(uploadId, offset, chunk, signal) {
    const response = await fileManagerApi.uploadChunk(uploadId, offset, chunk, signal);
    const body = await json(response);
    return { ok: response.ok, status: response.status, upload: body.upload, nextOffset: body.errorParams?.nextOffset, errorCode: body.errorCode };
  },
  async complete(uploadId) {
    const response = await fileManagerApi.completeUpload(uploadId);
    const body = await json(response);
    return { ok: response.ok, status: response.status, errorCode: body.errorCode };
  },
};

export function useChunkedUploads(onFinished: (root: string, dir: string) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((key: string, next: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...next } : item)));
  }, []);

  const run = useCallback(async (item: UploadItem, resumeId: string | null) => {
    const controller = new AbortController();
    controllers.current.set(item.key, controller);
    patch(item.key, { state: 'uploading', errorCode: null });
    const outcome = await runChunkedUpload({
      api,
      file: item.file,
      root: item.root,
      dir: item.dir,
      name: item.file.name,
      resumeId,
      signal: controller.signal,
      onProgress: (progress) => patch(item.key, { sent: progress.sent, uploadId: progress.uploadId }),
    });
    controllers.current.delete(item.key);
    if (outcome.kind === 'done') {
      patch(item.key, { state: 'done', sent: item.file.size });
      onFinished(item.root, item.dir);
    } else {
      patch(item.key, { state: 'failed', uploadId: outcome.uploadId, sent: outcome.sent, errorCode: outcome.errorCode ?? 'fileManager.page.uploadNetworkError' });
    }
  }, [onFinished, patch]);

  const enqueue = useCallback((files: File[], root: string, dir: string) => {
    const created = files.map((file): UploadItem => ({ key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, root, dir, sent: 0, state: 'uploading', uploadId: null, errorCode: null }));
    setItems((current) => [...current.filter((item) => item.state !== 'done'), ...created]);
    for (const item of created) void run(item, null);
  }, [run]);

  const resume = useCallback((key: string) => {
    const item = items.find((entry) => entry.key === key);
    if (item) void run(item, item.uploadId);
  }, [items, run]);

  const discard = useCallback((key: string) => {
    const item = items.find((entry) => entry.key === key);
    controllers.current.get(key)?.abort();
    if (item?.uploadId && item.state !== 'done') void fileManagerApi.abortUpload(item.uploadId).catch(() => undefined);
    setItems((current) => current.filter((entry) => entry.key !== key));
  }, [items]);

  return { items, enqueue, resume, discard, busy: items.some((item) => item.state === 'uploading') };
}
