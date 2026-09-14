import type { AuthMiddleware } from '../../core/auth';
import {
  buildStructuredApiError,
  isStructuredRequestError,
  OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE,
  OPENCLAW_UPDATE_RESET_FAILED_ERROR_CODE,
  OPENCLAW_UPDATE_START_FAILED_ERROR_CODE,
  OPENCLAW_UPDATE_STATUS_FAILED_ERROR_CODE,
  OPENCLAW_VERSION_LOOKUP_FAILED_ERROR_CODE,
  type RouteApp,
  UPDATE_CANCEL_FAILED_ERROR_CODE,
  UPDATE_RESET_FAILED_ERROR_CODE,
  UPDATE_RESTART_FAILED_ERROR_CODE,
  UPDATE_START_FAILED_ERROR_CODE,
  VERSION_INFO_UNAVAILABLE_ERROR_CODE,
  VERSION_LOOKUP_FAILED_ERROR_CODE,
} from '../../core/http';
import { readCliErrorDetail } from '../../core/process';
import { readOpenClawVersion } from '../../openclaw';
import type { AppUpdateService } from './app-update-service';
import { getCurrentAppVersionInfo, getLatestVersionInfo } from './app-version';
import type { OpenClawUpdateService } from './openclaw-update-service';

export function registerVersionRoutes(app: RouteApp): void {
  // API Routes
  app.get('/api/version', (_req, res) => {
    (async () => {
      try {
        res.json({
          ...getCurrentAppVersionInfo(),
          openclawVersion: await readOpenClawVersion(),
        });
      } catch (error: any) {
        res.status(500).json(buildStructuredApiError(
          VERSION_INFO_UNAVAILABLE_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        ));
      }
    })().catch((error: any) => {
      res.status(500).json(buildStructuredApiError(
        VERSION_INFO_UNAVAILABLE_ERROR_CODE,
        error instanceof Error ? error.message : String(error),
      ));
    });
  });
}

export type UpdateRoutesDeps = {
  appUpdate: AppUpdateService;
  openclawUpdate: OpenClawUpdateService;
  auth: AuthMiddleware;
};

export function registerUpdateRoutes(app: RouteApp, ctx: UpdateRoutesDeps): void {
  const { buildUpdateStatusResponse, cancelUpdateTask, rememberLatestVersionInfo, resetUpdateTaskState, restartClawUiService, startUpdateTask } = ctx.appUpdate;
  const { buildOpenClawUpdateStatusResponseAsync, cancelOpenClawUpdateTask, getOpenClawLatestVersionInfo, resetOpenClawUpdateTaskState, startOpenClawUpdateTask } = ctx.openclawUpdate;
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/version/latest', async (_req, res) => {
    try {
      const latestInfo = await getLatestVersionInfo();
      rememberLatestVersionInfo(latestInfo);
      res.json(latestInfo);
    } catch (error: any) {
      console.error('[VersionCheck] Failed to fetch latest release:', error instanceof Error ? error.message : String(error));
      res.status(502).json(buildStructuredApiError(
        VERSION_LOOKUP_FAILED_ERROR_CODE,
        error instanceof Error ? error.message : String(error),
      ));
    }
  });

  app.get('/api/openclaw/version/latest', async (_req, res) => {
    try {
      const latestInfo = await getOpenClawLatestVersionInfo();
      res.json(latestInfo);
    } catch (error: any) {
      console.error('[OpenClawVersionCheck] Failed to fetch latest version:', error instanceof Error ? error.message : String(error));
      res.status(502).json(buildStructuredApiError(
        OPENCLAW_VERSION_LOOKUP_FAILED_ERROR_CODE,
        error instanceof Error ? error.message : String(error),
      ));
    }
  });

  app.get('/api/openclaw/update/status', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await buildOpenClawUpdateStatusResponseAsync();
      res.json({
        success: true,
        update,
      });
    })().catch((error: any) => {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_STATUS_FAILED_ERROR_CODE, detail));
    });
  });

  app.post('/api/openclaw/update/start', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await startOpenClawUpdateTask();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_START_FAILED_ERROR_CODE, detail));
    });
  });

  app.post('/api/openclaw/update/cancel', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await cancelOpenClawUpdateTask();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_CANCEL_FAILED_ERROR_CODE, detail));
    });
  });

  app.post('/api/openclaw/update/reset', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await resetOpenClawUpdateTaskState();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(OPENCLAW_UPDATE_RESET_FAILED_ERROR_CODE, detail));
    });
  });

  app.get('/api/update/status', requireAdminAuth, (_req, res) => {
    res.json({
      success: true,
      update: buildUpdateStatusResponse(),
    });
  });

  app.post('/api/update/start', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await startUpdateTask();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(UPDATE_START_FAILED_ERROR_CODE, detail));
    });
  });

  app.post('/api/update/cancel', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await cancelUpdateTask();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(UPDATE_CANCEL_FAILED_ERROR_CODE, detail));
    });
  });

  app.post('/api/update/reset', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await resetUpdateTaskState();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(UPDATE_RESET_FAILED_ERROR_CODE, detail));
    });
  });

  app.post('/api/update/restart-service', requireAdminAuth, (_req, res) => {
    (async () => {
      const update = await restartClawUiService();
      res.json({ success: true, update });
    })().catch((error: any) => {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      res.status(500).json(buildStructuredApiError(UPDATE_RESTART_FAILED_ERROR_CODE, detail));
    });
  });
}
