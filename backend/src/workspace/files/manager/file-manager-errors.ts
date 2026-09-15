/**
 * 文件管理器的结构化错误：`fileManager.*` 码 + HTTP 状态。前端只认 errorCode 本地化主句，
 * errorDetail 是已脱敏的诊断信息（远端命令的 stderr 末几行等）。
 */
import type express from 'express';

import { buildStructuredApiError, isStructuredRequestError, REVISION_CONFLICT_ERROR_CODE, REVISION_REQUIRED_ERROR_CODE } from '../../../core/http';

export class FileManagerError extends Error {
  constructor(
    readonly errorCode: string,
    readonly status = 400,
    readonly detail: string | null = null,
    readonly extra: Record<string, unknown> | null = null,
  ) {
    super(errorCode);
    this.name = 'FileManagerError';
  }
}

export const fmError = {
  invalidPath: () => new FileManagerError('fileManager.invalidPath', 400),
  notFound: () => new FileManagerError('fileManager.notFound', 404),
  rootNotFound: () => new FileManagerError('fileManager.rootNotFound', 404),
  forbidden: () => new FileManagerError('auth.agentForbidden', 403),
  adminRequired: () => new FileManagerError('auth.forbidden', 403),
  deniedFile: () => new FileManagerError('fileManager.deniedFile', 403),
  outsideRoot: () => new FileManagerError('fileManager.outsideRoot', 403),
  tooLarge: (limitBytes: number) => new FileManagerError('fileManager.tooLarge', 413, null, { limitBytes }),
  notText: () => new FileManagerError('fileManager.notText', 415),
  exists: () => new FileManagerError('fileManager.alreadyExists', 409),
  notDirectory: () => new FileManagerError('fileManager.notDirectory', 400),
  isDirectory: () => new FileManagerError('fileManager.isDirectory', 400),
  directoryNotEmpty: () => new FileManagerError('fileManager.directoryNotEmpty', 409),
  backendError: (detail: string | null) => new FileManagerError('fileManager.backendError', 502, detail),
  backendTimeout: () => new FileManagerError('fileManager.backendTimeout', 504),
  backendUnavailable: (reasonCode: string) => new FileManagerError('fileManager.backendUnavailable', 503, null, { reasonCode }),
  hostKeyUnknown: (detail: string | null) => new FileManagerError('fileManager.hostKeyUnknown', 409, detail),
  invalidInput: (field: string) => new FileManagerError('fileManager.invalidInput', 400, null, { field }),
  revisionConflict: (current: unknown) => new FileManagerError(REVISION_CONFLICT_ERROR_CODE, 412, null, { current }),
  revisionRequired: () => new FileManagerError(REVISION_REQUIRED_ERROR_CODE, 428),
};

export function sendFileManagerError(res: express.Response, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof FileManagerError) {
    const params = error.extra && Object.values(error.extra).every((value) => ['string', 'number', 'boolean'].includes(typeof value))
      ? (error.extra as Record<string, string | number | boolean>)
      : null;
    res.status(error.status).json({ ...buildStructuredApiError(error.errorCode, error.detail, params), ...(error.extra && !params ? error.extra : {}) });
    return;
  }
  if (isStructuredRequestError(error)) {
    res.status(error.status).json(error.payload);
    return;
  }
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    res.status(404).json(buildStructuredApiError('fileManager.notFound'));
    return;
  }
  if (code === 'EEXIST') {
    res.status(409).json(buildStructuredApiError('fileManager.alreadyExists'));
    return;
  }
  if (code === 'ENOTEMPTY') {
    res.status(409).json(buildStructuredApiError('fileManager.directoryNotEmpty'));
    return;
  }
  if (code === 'EACCES' || code === 'EPERM') {
    res.status(403).json(buildStructuredApiError('fileManager.permissionDenied'));
    return;
  }
  console.error(`[FileManager] request failed: ${code ?? (error as Error)?.name ?? 'Error'}`);
  res.status(500).json(buildStructuredApiError('fileManager.internalError'));
}

export function fmHandler(handler: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => sendFileManagerError(res, error));
  };
}
