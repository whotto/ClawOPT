import path from 'path';
import fs from 'fs';
import express from 'express';

import type { ConfigManager } from '../../core/config';
import type { DB } from '../../core/db';
import { assertServablePath } from '../../core/files';
import {
  FILE_PREVIEW_CONVERSION_TIMED_OUT_ERROR_CODE,
  isStructuredRequestError,
  StructuredRequestError,
} from '../../core/http';
import { previewCacheDir, uploadDir } from '../../core/paths';
import { execFileWithInput, execPromise } from '../../core/process';
import { applyServedFileHeaders } from '../files/served-file-headers';

const HTML_PREVIEW_ROUTE_PADDING_SEGMENT = '__claw_preview_root__';

function decodeAbsolutePathParam(b64Path: string): string {
  const absolutePath = Buffer.from(b64Path, 'base64').toString('utf8');
  if (!path.isAbsolute(absolutePath)) {
    throw new Error('Only absolute paths are allowed');
  }
  return absolutePath;
}

function decodeBase64UrlUtf8(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function resolveHtmlPreviewRequestedPath(entryAbsolutePath: string, relativePath: string | undefined): string {
  const normalizedRelativePath = (relativePath || '')
    .split('/')
    .filter(Boolean)
    .filter((segment) => segment !== HTML_PREVIEW_ROUTE_PADDING_SEGMENT)
    .join('/');

  if (!normalizedRelativePath || normalizedRelativePath === path.basename(entryAbsolutePath)) {
    return entryAbsolutePath;
  }

  // 相对段里过滤了空段与 padding 段，但没过滤 `..`——一个 HTML 里写
  // <img src="../../../../etc/passwd"> 就能越界。子资源必须留在入口文件所在目录内。
  const entryDir = path.dirname(entryAbsolutePath);
  const resolved = path.resolve(entryDir, normalizedRelativePath);
  const relative = path.relative(entryDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StructuredRequestError(403, 'files.notServable', 'This file is not available');
  }
  return resolved;
}

export type PreviewServiceDeps = {
  configManager: ConfigManager;
  db: DB;
};

export function createPreviewService(ctx: PreviewServiceDeps) {
  const { configManager, db } = ctx;

  // LibreOffice detection
  let hasLibreOffice = false;
  const previewConversionPromises = new Map<string, Promise<string>>();

  /** 路由读的是探测结果的当前值，不是工厂创建那一刻的快照。 */
  function isLibreOfficeAvailable() {
    return hasLibreOffice;
  }

  function detectLibreOffice() {
    (async () => {
      try {
        await execPromise('which libreoffice');
        hasLibreOffice = true;
        console.log('[Preview] ✅ LibreOffice detected - high-fidelity preview enabled');
      } catch {
        hasLibreOffice = false;
        console.log('[Preview] ⚠️  LibreOffice not found - using client-side preview fallback');
      }
    })();
  }

  function resolveStoredPreviewAbsolutePath(filenameParam?: string): string {
    if (!filenameParam) {
      return '';
    }

    const decodedFilename = decodeURIComponent(filenameParam);
    const fileInfo = db.getFileByStoredName(decodedFilename);
    if (fileInfo && fs.existsSync(fileInfo.stored_path)) {
      return fileInfo.stored_path;
    }

    const globalPath = path.join(uploadDir, decodedFilename);
    if (fs.existsSync(globalPath)) {
      return globalPath;
    }

    return '';
  }

  function resolvePreviewAbsolutePath(req: express.Request): string {
    const b64Path = req.query.path as string | undefined;
    const filenameParam = req.query.filename as string | undefined;

    if (b64Path) {
      return assertServablePath(decodeAbsolutePathParam(b64Path));
    }

    const stored = resolveStoredPreviewAbsolutePath(filenameParam);
    return stored ? assertServablePath(stored) : stored;
  }

  async function ensureConvertedPreviewPdf(absolutePath: string): Promise<string> {
    if (!hasLibreOffice) {
      throw new Error('LibreOffice not available');
    }

    const crypto = require('crypto');
    const stat = fs.statSync(absolutePath);
    const cacheKey = crypto.createHash('md5').update(`${absolutePath}:${stat.mtimeMs}`).digest('hex');
    const cachedPdf = path.join(previewCacheDir, `${cacheKey}.pdf`);

    if (fs.existsSync(cachedPdf)) {
      return cachedPdf;
    }

    const inFlight = previewConversionPromises.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const conversionPromise = (async () => {
      const tmpDir = fs.mkdtempSync(path.join(previewCacheDir, `${cacheKey}-`));
      const startedAt = Date.now();
      const timeoutSeconds = configManager.getConfig().previewConversionTimeoutSeconds || 60;
      const timeoutMs = timeoutSeconds * 1000;

      try {
        await execFileWithInput(
          'libreoffice',
          ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, absolutePath],
          '',
          { timeout: timeoutMs }
        );

        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.pdf'));
        if (files.length === 0) {
          throw new Error('LibreOffice conversion produced no PDF output');
        }

        const outputPdf = path.join(tmpDir, files[0]);
        fs.renameSync(outputPdf, cachedPdf);
        console.log(`[Preview] Converted ${path.basename(absolutePath)} in ${Date.now() - startedAt}ms`);

        return cachedPdf;
      } catch (error: any) {
        const detail = [error?.stderr, error?.stdout, error?.message]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .join(' | ');
        if (error?.timedOut) {
          console.error(
            `[Preview] LibreOffice conversion timed out for ${absolutePath} after ${Date.now() - startedAt}ms (configured ${timeoutMs}ms)${detail ? `: ${detail}` : ''}`
          );
          throw new StructuredRequestError(
            504,
            FILE_PREVIEW_CONVERSION_TIMED_OUT_ERROR_CODE,
            detail || null,
            { timeoutSeconds }
          );
        }
        console.error(
          `[Preview] LibreOffice conversion failed for ${absolutePath} after ${Date.now() - startedAt}ms${detail ? `: ${detail}` : ''}`
        );
        throw error;
      } finally {
        previewConversionPromises.delete(cacheKey);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    })();

    previewConversionPromises.set(cacheKey, conversionPromise);
    return conversionPromise;
  }

  function resolveHtmlPreviewEntryAbsolutePath(req: express.Request): string {
    if (req.params.encodedPath) {
      const absolutePath = decodeBase64UrlUtf8(req.params.encodedPath);
      if (!path.isAbsolute(absolutePath)) {
        throw new Error('Only absolute paths are allowed');
      }
      return assertServablePath(absolutePath);
    }

    if (req.params.filename) {
      const stored = resolveStoredPreviewAbsolutePath(req.params.filename);
      return stored ? assertServablePath(stored) : stored;
    }

    return '';
  }

  /**
   * `authorize` 是第二道门（数据面授权），在可服务路径闸门之后对实际要发的文件判（没有相对段时就是入口本身；
   * 子资源按 realpath 判，入口目录里指向别人工作区的软链挡得住）；看不见就抛。
   * 必填：HTML 预览没有「不判授权」的调用方式。
   */
  function serveHtmlPreviewRequest(req: express.Request, res: express.Response, authorize: (realPath: string) => void) {
    try {
      const entryAbsolutePath = resolveHtmlPreviewEntryAbsolutePath(req);
      if (!entryAbsolutePath || !fs.existsSync(entryAbsolutePath)) {
        return res.status(404).send('File not found');
      }

      const requestedPath = assertServablePath(resolveHtmlPreviewRequestedPath(entryAbsolutePath, req.params[0]));
      authorize(requestedPath);
      if (!fs.existsSync(requestedPath)) {
        return res.status(404).send('File not found');
      }

      const stat = fs.statSync(requestedPath);
      if (!stat.isFile()) {
        return res.status(404).send('File not found');
      }

      const filename = path.basename(requestedPath);
      applyServedFileHeaders(res, { filename, cache: 'no-store', disposition: 'inline' });
      return res.sendFile(requestedPath);
    } catch (error: any) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      console.error(`[HTML Preview Error] ${error.message}`);
      if (error.message === 'Only absolute paths are allowed') {
        return res.status(403).send(error.message);
      }
      return res.status(500).send('Failed to serve HTML preview');
    }
  }

  return {
    resolvePreviewAbsolutePath,
    ensureConvertedPreviewPdf,
    serveHtmlPreviewRequest,
    detectLibreOffice,
    isLibreOfficeAvailable,
  };
}
export type PreviewService = ReturnType<typeof createPreviewService>;
