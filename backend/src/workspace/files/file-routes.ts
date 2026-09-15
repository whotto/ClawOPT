import type express from 'express';
import fs from 'fs';
import path from 'path';

import { getRequestIdentity, resourceForbiddenError, type ResourceAccess } from '../../core/auth';
import type { DB } from '../../core/db';
import { resolveServablePath, servedPathOwner } from '../../core/files';
import { isStructuredRequestError, type RouteApp } from '../../core/http';
import { uploadDir } from '../../core/paths';
import type { PreviewService } from '../preview/preview-service';
import { applyPreviewDataHeaders, applyServedFileHeaders } from './served-file-headers';

export type FileRoutesDeps = {
  db: DB;
  preview: PreviewService;
  access: Pick<ResourceAccess, 'canAccessServedFile'>;
};

/**
 * 按路径出文件的入口一律两道门，顺序固定：
 * 1. 可服务路径闸门（`resolveServablePath` / `assertServablePath`，先 realpath 再判归属与文件名）；
 * 2. 数据面授权（`servedPathOwner` 推出文件归哪个 Agent / 群 / 上传记录，再按用户判，见 `core/auth/resource-access.ts`）。
 * 第二道门只接受第一道门给出的 realPath。
 */
export function registerFileRoutes(app: RouteApp, ctx: FileRoutesDeps): void {
  const { db } = ctx;
  const { ensureConvertedPreviewPdf, isLibreOfficeAvailable, resolvePreviewAbsolutePath, serveHtmlPreviewRequest } = ctx.preview;

  /** 第二道门：看不见就抛 403 `auth.agentForbidden`。 */
  const authorizeServedFile = (req: express.Request, realPath: string): void => {
    if (!ctx.access.canAccessServedFile(getRequestIdentity(req), servedPathOwner(realPath))) throw resourceForbiddenError();
  };
  const sendForbidden = (res: express.Response) => {
    const error = resourceForbiddenError();
    res.status(error.status).json(error.payload);
  };

  app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename;

    // 1. 先查登记（Agent / 群工作区里的上传），2. 再回落全局上传目录。两者都过可服务路径闸门与授权。
    const fileInfo = db.getFileByStoredName(filename);
    const candidates = [fileInfo?.stored_path, path.join(uploadDir, filename)].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const candidate of candidates) {
      const verdict = resolveServablePath(candidate);
      if (!verdict.ok) {
        if (verdict.reason === 'notFound') continue;
        return res.status(403).send('Not available');
      }
      try {
        authorizeServedFile(req, verdict.realPath);
      } catch {
        return sendForbidden(res);
      }
      applyServedFileHeaders(res, { filename: path.basename(verdict.realPath), cache: 'revalidate' });
      return res.sendFile(verdict.realPath);
    }

    res.status(404).send('File not found');
  });


  // Serve OpenClaw workspace files.
  //
  // 这里原本是 `express.static(~/.openclaw)`，把整棵目录树挂了出去——`openclaw.json`
  // 里的模型 API key、`agents/*/agent/auth-profiles.json` 里的凭据、每个智能体的记忆，
  // 未鉴权一次 GET 全拿得到。现在走与 `/api/files/download` 同一道白名单闸门：
  // 只有工作区与上传目录下的非凭据文件可以被服务。
  app.get(/^\/openclaw\/(.+)/, (req, res) => {
    const relative = decodeURIComponent(req.params[0] || '');
    const verdict = resolveServablePath(path.join(process.env.HOME || '', '.openclaw', relative));
    if (!verdict.ok) {
      return res.status(verdict.reason === 'notFound' ? 404 : 403).send('Not available');
    }
    try {
      authorizeServedFile(req, verdict.realPath);
    } catch {
      return sendForbidden(res);
    }
    applyServedFileHeaders(res, { filename: path.basename(verdict.realPath), cache: 'revalidate' });
    res.sendFile(verdict.realPath);
  });

  // Securely serve arbitrary local files via base64 encoded paths
  app.get('/api/files/download', (req, res) => {
    const b64Path = req.query.path as string;
    const disposition = req.query.disposition === 'inline' ? 'inline' : 'attachment';
    if (!b64Path) {
      return res.status(400).send('Missing path parameter');
    }

    try {
      const absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');

      // 「是不是绝对路径」不是安全检查：它放行 /etc/passwd、~/.ssh/id_rsa 与
      // auth-profiles.json。真正的判据是这个文件是否落在允许的工作区/上传目录内，
      // 且不是凭据类文件；路径先 realpath 再判归属，符号链接逃不出去。
      const verdict = resolveServablePath(absolutePath);
      if (!verdict.ok) {
        if (verdict.reason === 'notFound') return res.status(404).send('File not found');
        if (verdict.reason === 'notAbsolute') return res.status(403).send('Only absolute paths are allowed');
        console.warn(`[Download Blocked] ${verdict.reason}: ${absolutePath}`);
        return res.status(403).send('This file is not available for download');
      }

      try {
        authorizeServedFile(req, verdict.realPath);
      } catch {
        return sendForbidden(res);
      }

      const filename = path.basename(verdict.realPath);
      // Allow inline responses for preview while keeping attachment as the default download behavior.
      applyServedFileHeaders(res, { filename, cache: 'no-store', disposition });
      res.sendFile(verdict.realPath);
    } catch (error: any) {
      console.error(`[Download Error] ${error.message}`);
      res.status(500).send('Failed to serve file');
    }
  });

  // File preview capabilities
  app.get('/api/files/capabilities', (_req, res) => {
    res.json({ libreoffice: isLibreOfficeAvailable() });
  });

  app.get('/api/files/preview-data', async (req, res) => {
    try {
      const mode = req.query.mode === 'converted' ? 'converted' : 'source';
      const absolutePath = resolvePreviewAbsolutePath(req);

      if (!absolutePath || !fs.existsSync(absolutePath)) {
        return res.status(404).json({ error: 'File not found' });
      }
      authorizeServedFile(req, absolutePath);

      const servedPath = mode === 'converted'
        ? await ensureConvertedPreviewPdf(absolutePath)
        : absolutePath;

      const buffer = fs.readFileSync(servedPath);
      applyPreviewDataHeaders(res);
      res.json({
        filename: path.basename(servedPath),
        data: buffer.toString('base64'),
        mimeType: mode === 'converted' ? 'application/pdf' : undefined,
      });
    } catch (error: any) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      console.error(`[Preview Data Error] ${error.message}`);
      if (error.message === 'Only absolute paths are allowed') {
        return res.status(403).json({ error: error.message });
      }
      if (error.message === 'LibreOffice not available') {
        return res.status(501).json({ error: error.message, fallback: true });
      }
      res.status(500).json({ error: 'Preview data failed', message: error.message });
    }
  });

  app.get('/api/files/html-preview/path/:encodedPath/*', (req, res) => {
    serveHtmlPreviewRequest(req, res, (realPath) => authorizeServedFile(req, realPath));
  });

  app.get('/api/files/html-preview/upload/:filename/*', (req, res) => {
    serveHtmlPreviewRequest(req, res, (realPath) => authorizeServedFile(req, realPath));
  });

  app.get('/api/files/preview', async (req, res) => {
    try {
      const mode = req.query.mode === 'source' ? 'source' : 'converted';
      const absolutePath = resolvePreviewAbsolutePath(req);

      if (!absolutePath) {
        return res.status(404).send('File not found');
      }

      if (!fs.existsSync(absolutePath)) {
        return res.status(404).send('File not found');
      }
      authorizeServedFile(req, absolutePath);

      const filename = path.basename(absolutePath);

      if (mode === 'source') {
        applyServedFileHeaders(res, { filename, cache: 'no-store', disposition: 'inline' });
        return res.sendFile(absolutePath);
      }

      if (!isLibreOfficeAvailable()) {
        return res.status(501).json({ error: 'LibreOffice not available', fallback: true });
      }

      const cachedPdf = await ensureConvertedPreviewPdf(absolutePath);
      res.setHeader('Content-Type', 'application/pdf');
      applyServedFileHeaders(res, { filename: path.basename(cachedPdf), cache: 'no-store', disposition: 'inline' });
      res.sendFile(cachedPdf);
    } catch (error: any) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      console.error(`[Preview Error] ${error.message}`);
      if (error.message === 'Only absolute paths are allowed') {
        return res.status(403).send(error.message);
      }
      res.status(500).json({ error: 'Preview conversion failed', message: error.message });
    }
  });
}
