import express from 'express';

import { getRequestIdentity, type AuthMiddleware } from '../../../core/auth';
import { readRequestedRevision, type RouteApp } from '../../../core/http';
import { fmHandler, sendFileManagerError } from './file-manager-errors';
import { UPLOAD_MAX_CHUNK_BYTES } from './chunked-upload';
import type { FileManagerService } from './file-manager-service';

export type FileManagerRoutesDeps = {
  auth: AuthMiddleware;
  fileManager: FileManagerService;
};

/** RFC 5987：ASCII 回退名 + UTF-8 `filename*`。 */
export function contentDispositionAttachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * 文件管理器 `/api/fs/*`。闸门在登记表里可见：
 * - 读（根列表、列目录、详情、读文本、下载、预览地址）：登录即可，服务里按根判授权（member 只见自己 Agent 的工作区）；
 * - 改（写、改名、复制、删除、新建目录、分块上传）：`requireAdminAuth`；
 * - 额外根、远端连接、known_hosts：`requireSuperAdmin`。
 */
export function registerFileManagerRoutes(app: RouteApp, ctx: FileManagerRoutesDeps): void {
  const { fileManager } = ctx;
  const { requireAdminAuth, requireSuperAdmin } = ctx.auth;
  const identity = (req: express.Request) => getRequestIdentity(req);
  // 分块只在这一条路由上按原始字节解析；上限比块上限多 1 字节，超限回结构化 413 而不是解析器的 500。
  const rawChunk = express.raw({ type: () => true, limit: UPLOAD_MAX_CHUNK_BYTES + 1 });

  app.get('/api/fs/roots', fmHandler(async (req, res) => {
    res.json({ success: true, roots: await fileManager.listRoots(identity(req)) });
  }));

  app.get('/api/fs/list', fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.list(identity(req), { root: req.query.root, path: req.query.path })) });
  }));

  app.get('/api/fs/stat', fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.stat(identity(req), { root: req.query.root, path: req.query.path })) });
  }));

  app.get('/api/fs/read', fmHandler(async (req, res) => {
    const file = await fileManager.read(identity(req), { root: req.query.root, path: req.query.path });
    res.setHeader('ETag', `"${file.revision}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, file });
  }));

  app.get('/api/fs/download', fmHandler(async (req, res) => {
    const file = await fileManager.download(identity(req), { root: req.query.root, path: req.query.path });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDispositionAttachment(file.name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(file.size));
    file.stream.on('error', (error) => sendFileManagerError(res, error));
    res.on('close', () => file.stream.destroy());
    file.stream.pipe(res);
  }));

  app.get('/api/fs/preview-link', fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.previewLink(identity(req), { root: req.query.root, path: req.query.path })) });
  }));

  app.put('/api/fs/write', requireAdminAuth, fmHandler(async (req, res) => {
    const result = await fileManager.write(identity(req), { root: req.body?.root, path: req.body?.path, content: req.body?.content, revision: readRequestedRevision(req) });
    res.setHeader('ETag', `"${result.revision}"`);
    res.json({ success: true, ...result });
  }));

  app.post('/api/fs/mkdir', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.mkdir(identity(req), { root: req.body?.root, path: req.body?.path })) });
  }));

  app.post('/api/fs/rename', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.rename(identity(req), { root: req.body?.root, from: req.body?.from, to: req.body?.to })) });
  }));

  app.post('/api/fs/copy', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.copy(identity(req), { root: req.body?.root, from: req.body?.from, to: req.body?.to })) });
  }));

  app.post('/api/fs/delete', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.remove(identity(req), { root: req.body?.root, path: req.body?.path, recursive: req.body?.recursive })) });
  }));

  // ---- 可续传分块上传 ----

  app.post('/api/fs/uploads', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, upload: await fileManager.beginUpload(identity(req), { root: req.body?.root, dir: req.body?.dir, name: req.body?.name, size: req.body?.size, overwrite: req.body?.overwrite }) });
  }));

  app.get('/api/fs/uploads/:uploadId', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, upload: await fileManager.uploadStatus(identity(req), req.params.uploadId) });
  }));

  app.put('/api/fs/uploads/:uploadId/chunks', requireAdminAuth, (req, res, next) => {
    rawChunk(req, res, (error?: unknown) => {
      if (!error) return next();
      const tooLarge = (error as { type?: string }).type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({ success: false, errorCode: tooLarge ? 'fileManager.tooLarge' : 'fileManager.invalidInput', errorParams: tooLarge ? { limitBytes: UPLOAD_MAX_CHUNK_BYTES } : { field: 'chunk' }, errorDetail: null });
    });
  }, fmHandler(async (req, res) => {
    res.json({ success: true, upload: await fileManager.uploadChunk(identity(req), req.params.uploadId, req.query.offset, req.body) });
  }));

  app.post('/api/fs/uploads/:uploadId/complete', requireAdminAuth, fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.completeUpload(identity(req), req.params.uploadId)) });
  }));

  app.delete('/api/fs/uploads/:uploadId', requireAdminAuth, fmHandler(async (req, res) => {
    await fileManager.abortUpload(identity(req), req.params.uploadId);
    res.json({ success: true });
  }));

  // ---- 配置：额外根、远端连接、known_hosts（super_admin） ----

  app.get('/api/fs/config', requireSuperAdmin, fmHandler(async (req, res) => {
    res.json({ success: true, ...(await fileManager.config(identity(req))) });
  }));

  app.post('/api/fs/extra-roots', requireSuperAdmin, fmHandler(async (req, res) => {
    res.json({ success: true, root: await fileManager.addExtraRoot(identity(req), { name: req.body?.name, path: req.body?.path }) });
  }));

  app.delete('/api/fs/extra-roots/:rootId', requireSuperAdmin, fmHandler(async (req, res) => {
    await fileManager.removeExtraRoot(identity(req), req.params.rootId);
    res.json({ success: true });
  }));

  app.post('/api/fs/connections', requireSuperAdmin, fmHandler(async (req, res) => {
    const saved = await fileManager.saveConnection(identity(req), req.body ?? {});
    res.json({ success: true, connection: { id: saved.id } });
  }));

  app.put('/api/fs/connections/:connectionId', requireSuperAdmin, fmHandler(async (req, res) => {
    const saved = await fileManager.saveConnection(identity(req), req.body ?? {}, req.params.connectionId);
    res.json({ success: true, connection: { id: saved.id } });
  }));

  app.delete('/api/fs/connections/:connectionId', requireSuperAdmin, fmHandler(async (req, res) => {
    await fileManager.removeConnection(identity(req), req.params.connectionId);
    res.json({ success: true });
  }));

  app.post('/api/fs/connections/:connectionId/test', requireSuperAdmin, fmHandler(async (req, res) => {
    res.json({ success: true, result: await fileManager.testConnection(identity(req), req.params.connectionId) });
  }));

  app.post('/api/fs/known-hosts/scan', requireSuperAdmin, fmHandler(async (req, res) => {
    res.json({ success: true, scan: await fileManager.scanHostKeys(identity(req), { host: req.body?.host, port: req.body?.port }) });
  }));

  app.post('/api/fs/known-hosts/trust', requireSuperAdmin, fmHandler(async (req, res) => {
    res.json({ success: true, knownHosts: await fileManager.trustHostKeys(identity(req), { scanId: req.body?.scanId, fingerprints: req.body?.fingerprints }) });
  }));

  app.post('/api/fs/known-hosts/remove', requireSuperAdmin, fmHandler(async (req, res) => {
    res.json({ success: true, knownHosts: await fileManager.removeHostKey(identity(req), { hostPattern: req.body?.hostPattern, fingerprint: req.body?.fingerprint }) });
  }));
}
