import type express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';

import { ensureGroupWorkspace, validateGroupId } from '../../collab/rooms';
import type { SessionManager } from '../../collab/sessions';
import type { AgentProvisioner } from '../../control';
import { getRequestIdentity, resourceForbiddenError, type ResourceAccess } from '../../core/auth';
import type { DB, StoredFileRow } from '../../core/db';
import {
  GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE,
  GROUP_ID_INVALID_ERROR_CODE,
  GROUP_ID_REQUIRED_ERROR_CODE,
  GROUP_NOT_FOUND_ERROR_CODE,
  StructuredRequestError,
} from '../../core/http';
import { uploadDir } from '../../core/paths';

type UploadTarget = {
  contextType: 'session' | 'group';
  sessionKey: string;
  workspacePath: string;
  uploadsPath: string;
  agentId?: string;
  groupId?: string;
};

function createGroupIdValidationError(rawId: unknown): StructuredRequestError {
  const validation = validateGroupId(rawId);
  switch (validation.issue) {
    case 'required':
      return new StructuredRequestError(400, GROUP_ID_REQUIRED_ERROR_CODE);
    case 'whitespace':
      return new StructuredRequestError(400, GROUP_ID_CONTAINS_WHITESPACE_ERROR_CODE);
    default:
      return new StructuredRequestError(400, GROUP_ID_INVALID_ERROR_CODE, null, {
        groupId: validation.normalizedId || String(rawId || ''),
      });
  }
}

function removeStoredFilesFromDisk(files: StoredFileRow[]): void {
  for (const file of files) {
    if (!file.stored_path) continue;
    try {
      if (fs.existsSync(file.stored_path)) {
        fs.rmSync(file.stored_path, { force: true });
      }
    } catch (error) {
      console.error(`[Files] Failed to remove stored file ${file.stored_path}:`, error);
    }
  }
}

export type UploadServiceDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  sessionManager: SessionManager;
  access: Pick<ResourceAccess, 'canUploadTo'>;
};

export function createUploadService(ctx: UploadServiceDeps) {
  const { agentProvisioner, db, sessionManager, access } = ctx;

  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      try {
        const target = resolveUploadTargetFromBody((req.body || {}) as Record<string, unknown>);
        // 数据面授权在落盘之前：目标会话 / 群看不见就不写任何字节（multipart 字段须在文件之前，前端就是这么发的）。
        if (!access.canUploadTo(getRequestIdentity(req as express.Request), target)) throw resourceForbiddenError();
        fs.mkdirSync(target.uploadsPath, { recursive: true });
        console.log(`[Upload] Context: ${target.contextType}, SessionKey: ${target.sessionKey}, Path: ${target.uploadsPath}`);
        cb(null, target.uploadsPath);
      } catch (err) {
        cb(err as Error, uploadDir);
      }
    },
    filename: (_req, file, cb) => {
      const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const safe = decodedName.replace(/[^a-zA-Z0-9.\u4e00-\u9fa5_-]/g, '_');
      file.originalname = decodedName; // Save decoded name back for later use
      cb(null, `${Date.now()}-${safe}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
  });

  function resolveUploadTargetFromBody(body: Record<string, unknown> | undefined): UploadTarget {
    const contextType = typeof body?.contextType === 'string' ? body.contextType.trim() : '';
    const rawGroupId = typeof body?.groupId === 'string' ? body.groupId : '';

    if (contextType === 'group' || rawGroupId) {
      const validation = validateGroupId(rawGroupId);
      if (validation.issue) {
        throw createGroupIdValidationError(rawGroupId);
      }

      const groupId = validation.normalizedId;
      const group = db.getGroupChat(groupId);
      if (!group) {
        throw new StructuredRequestError(404, GROUP_NOT_FOUND_ERROR_CODE, null, { groupId });
      }

      const { workspacePath, uploadsPath } = ensureGroupWorkspace(groupId);
      return {
        contextType: 'group',
        sessionKey: groupId,
        workspacePath,
        uploadsPath,
        groupId,
      };
    }

    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
    const sessionInfo = sessionManager.getSession(sessionId);
    const agentId = sessionInfo?.agentId || 'main';
    const workspacePath = agentProvisioner.getWorkspacePath(agentId);

    return {
      contextType: 'session',
      sessionKey: sessionId,
      workspacePath,
      uploadsPath: path.join(workspacePath, 'uploads'),
      agentId,
    };
  }

  function clearStoredFilesBySessionKey(sessionKey: string): void {
    const files = db.getFilesBySession(sessionKey);
    removeStoredFilesFromDisk(files);
    db.deleteFilesBySession(sessionKey);
  }

  return {
    upload,
    resolveUploadTargetFromBody,
    clearStoredFilesBySessionKey,
  };
}
export type UploadService = ReturnType<typeof createUploadService>;
