import multer from 'multer';
import fs from 'fs';
import sharp from 'sharp';
import path from 'path';

import { getRequestIdentity, type ResourceAccess } from '../../core/auth';
import type { DB } from '../../core/db';
import { isStructuredRequestError, type RouteApp } from '../../core/http';
import type { UploadService } from './upload-service';

export type UploadRoutesDeps = {
  db: DB;
  uploads: UploadService;
  access: Pick<ResourceAccess, 'canAccessSessionOrRoom'>;
};

export function registerUploadRoutes(app: RouteApp, ctx: UploadRoutesDeps): void {
  const { db } = ctx;
  const { resolveUploadTargetFromBody, upload } = ctx.uploads;

  // file upload (doc/image/video/audio), supports multiple files
  app.post('/api/files/upload', (req, res) => {
    upload.array('files', 20)(req, res, async (error) => {
      if (error) {
        if (isStructuredRequestError(error)) {
          return res.status(error.status).json(error.payload);
        }
        if (error instanceof multer.MulterError) {
          return res.status(400).json({ success: false, error: error.message });
        }
        return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Upload failed' });
      }

      const files = (req.files as Express.Multer.File[]) || [];
      if (!files.length) return res.status(400).json({ success: false, error: 'No files uploaded' });

      const uploadTarget = resolveUploadTargetFromBody((req.body || {}) as Record<string, unknown>);
      const IMAGE_TARGET_SIZE = 4_500_000; // 4.5MB target for images (OpenClaw has 5MB limit)

      const saved = await Promise.all(files.map(async (f) => {
        let finalSize = f.size;

        if (f.mimetype.startsWith('image/')) {
          try {
            const originalBuffer = fs.readFileSync(f.path);
            const metadata = await sharp(originalBuffer).metadata();
            let width = metadata.width || 2048;
            let height = metadata.height || 2048;
            const maxDimension = 2048;

            if (width > maxDimension || height > maxDimension) {
              if (width > height) {
                height = Math.round((height / width) * maxDimension);
                width = maxDimension;
              } else {
                width = Math.round((width / height) * maxDimension);
                height = maxDimension;
              }
            }

            let quality = 80;

            while (quality >= 10) {
              const nextBuffer = await sharp(originalBuffer)
                .resize(width, height, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality, mozjpeg: true })
                .toBuffer();

              if (nextBuffer.length <= IMAGE_TARGET_SIZE || quality <= 10) {
                fs.writeFileSync(f.path, nextBuffer);
                finalSize = nextBuffer.length;
                break;
              }

              quality -= 10;
            }
          } catch (err) {
            console.error('[Upload] Image compression failed:', err);
          }
        }

        db.saveFile({
          sessionKey: uploadTarget.sessionKey,
          originalName: f.originalname,
          mimeType: f.mimetype,
          size: finalSize,
          storedPath: f.path,
        });

        return {
          name: f.originalname,
          mimeType: f.mimetype,
          size: finalSize,
          url: `/uploads/${path.basename(f.path)}`,
        };
      }));

      res.json({
        success: true,
        files: saved,
      });
    });
  });

  // 上传记录：member 只列看得见的会话 / 群里的（admin 在 canAccessSessionOrRoom 里全放行）。
  app.get('/api/files', (req, res) => {
    const identity = getRequestIdentity(req);
    const files = (db.getFiles(300) as Array<{ session_key?: string | null }>)
      .filter((row) => ctx.access.canAccessSessionOrRoom(identity, row.session_key ?? ''));
    res.json({ success: true, files });
  });
}
