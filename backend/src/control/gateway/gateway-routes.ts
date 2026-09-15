import type { AuthMiddleware } from '../../core/auth';
import path from 'path';
import os from 'os';
import fs from 'fs';

import {
  BROWSER_HEADED_MODE_LOAD_FAILED_ERROR_CODE,
  BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
  BROWSER_HEALTH_FAILED_ERROR_CODE,
  BROWSER_SELF_HEAL_FAILED_ERROR_CODE,
  buildStructuredApiError,
  GATEWAY_DETECT_FAILED_ERROR_CODE,
  GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE,
  GATEWAY_MAX_PERMISSIONS_UPDATE_FAILED_ERROR_CODE,
  GATEWAY_RESTART_FAILED_ERROR_CODE,
  GATEWAY_TEST_FAILED_ERROR_CODE,
  isStructuredRequestError,
  type RouteApp,
} from '../../core/http';
import { readCliErrorDetail } from '../../core/process';
import { normalizeCliText } from '../../core/util';
import {
  approveLatestDevicePairingRequest,
  type GatewayConnections,
  type GatewayService,
  probeGatewayConnectionStatus,
  readOpenClawConfigSafe,
  readOpenClawGatewayServiceRuntimeState,
  readOpenClawVersion,
  safeReadDevicePairingStatus,
} from '../../openclaw';
import {
  BROWSER_SELF_HEAL_GATEWAY_READY_TIMEOUT_MS,
  type BrowserService,
  readBrowserHeadedModeConfig,
  refreshOpenClawPluginRegistryForBrowserSelfHeal,
  resetOpenClawBrowserProfile,
  setBrowserHeadedModeEnabled,
  shouldRetryBrowserRepairWithProfileReset,
  stopOpenClawBrowserBestEffort,
  synchronizeConfiguredBrowserRepairSettings,
} from './browser-service';
import { safeReadHostTakeoverStatus } from './host-takeover';
import { configureMaxPermissionsState, readMaxPermissionsEnabled } from './max-permissions';

export type GatewayRoutesDeps = {
  auth: AuthMiddleware;
  browser: BrowserService;
  gatewayConnections: GatewayConnections;
  gatewayService: GatewayService;
};

export function registerGatewayRoutes(app: RouteApp, ctx: GatewayRoutesDeps): void {
  const { ensureBrowserTaskIdle, getBrowserTaskSnapshot, resetBrowserTaskSnapshot, runBrowserHealthCheck, updateBrowserTaskSnapshot, waitForBrowserGatewayReady } = ctx.browser;
  const { getActiveGatewayConnectionStatus } = ctx.gatewayConnections;
  // P5a：网关重启、浏览器自愈、最大权限、设备配对都是改主机状态的动作——多用户之后只给 admin。
  const { requireAdminAuth } = ctx.auth;
  const { buildGatewayStatusProbeParams, getGatewayRestartSnapshot, reconcileGatewayRestartSnapshot, resetGatewayRestartSnapshot, restartGatewayService, runTrackedGatewayRestart } = ctx.gatewayService;

  app.get('/api/gateway/status', async (_req, res) => {
    try {
      const activeConnectionStatus = getActiveGatewayConnectionStatus();
      if (activeConnectionStatus) {
        return res.json({
          connected: activeConnectionStatus.connected,
          message: activeConnectionStatus.message,
          source: activeConnectionStatus.source,
        });
      }

      const result = await probeGatewayConnectionStatus(buildGatewayStatusProbeParams(), { preferLocalHealth: true });
      res.json({
        connected: result.connected,
        message: result.message,
        source: result.source,
      });
    } catch (error: any) {
      res.json({ connected: false, message: error?.message || 'Connection failed' });
    }
  });

  app.post('/api/config/test', requireAdminAuth, async (req, res) => {
    const { gatewayUrl, token, password } = req.body;

    if (!gatewayUrl) {
      return res.status(400).json(buildStructuredApiError(GATEWAY_TEST_FAILED_ERROR_CODE, 'Gateway URL is required'));
    }

    try {
      const result = await probeGatewayConnectionStatus({ gatewayUrl, token, password });
      if (result.connected) {
        return res.json({ success: true, message: 'Connection successful', source: result.source });
      }

      res.json(buildStructuredApiError(
        GATEWAY_TEST_FAILED_ERROR_CODE,
        result.message || 'Connection failed',
      ));
    } catch (error: any) {
      console.error('[API] /api/config/test - Connection failed:', error);
      res.json(buildStructuredApiError(GATEWAY_TEST_FAILED_ERROR_CODE, error?.message || 'Connection failed'));
    }
  });

  app.get('/api/config/detect-all', async (_req, res) => {
    try {
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      let gatewayUrl = '';
      let token = '';
      let password = '';
      const openclawVersion = await readOpenClawVersion();

      if (fs.existsSync(configPath)) {
        const config = readOpenClawConfigSafe() ?? {};
        if (config.gateway) {
          gatewayUrl = `ws://127.0.0.1:${config.gateway.port || 18789}`;
          token = config.gateway.auth?.token || '';
          password = config.gateway.auth?.password || '';
        }
      }

      if (!gatewayUrl) {
        return res.json(buildStructuredApiError(GATEWAY_DETECT_FAILED_ERROR_CODE, 'Could not detect gateway config'));
      }

      res.json({
        success: true,
        data: {
          gatewayUrl,
          token,
          password,
          openclawVersion,
        }
      });
    } catch (error: any) {
      res.json(buildStructuredApiError(GATEWAY_DETECT_FAILED_ERROR_CODE, error?.message || 'Error detecting config'));
    }
  });

  app.get('/api/config/browser-health/status', (_req, res) => {
    res.json({
      success: true,
      task: getBrowserTaskSnapshot(),
    });
  });

  app.get('/api/config/browser-health', async (_req, res) => {
    let taskStarted = false;
    try {
      ensureBrowserTaskIdle();
      updateBrowserTaskSnapshot({
        status: 'checking',
        phase: 'read-config',
        rawDetail: null,
      });
      taskStarted = true;
      const health = await runBrowserHealthCheck((phase, rawDetail) => {
        updateBrowserTaskSnapshot({
          status: 'checking',
          phase,
          rawDetail: normalizeCliText(rawDetail) || null,
        });
      });
      res.json({ success: true, health });
    } catch (error: any) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      res.json(buildStructuredApiError(
        BROWSER_HEALTH_FAILED_ERROR_CODE,
        readCliErrorDetail(error) || error?.message || 'Browser health check failed'
      ));
    } finally {
      if (taskStarted) {
        resetBrowserTaskSnapshot();
      }
    }
  });

  app.get('/api/config/browser-headed-mode', (_req, res) => {
    try {
      res.json({
        success: true,
        config: readBrowserHeadedModeConfig(),
      });
    } catch (error: any) {
      res.status(500).json(buildStructuredApiError(
        BROWSER_HEADED_MODE_LOAD_FAILED_ERROR_CODE,
        error?.message || 'Failed to load browser headed mode config'
      ));
    }
  });

  app.get('/api/config/restart/status', async (_req, res) => {
    res.json({
      success: true,
      restart: await reconcileGatewayRestartSnapshot(),
    });
  });

  app.post('/api/config/restart/status/reset', requireAdminAuth, (_req, res) => {
    if (getGatewayRestartSnapshot().status === 'restarting') {
      return res.status(409).json({
        ...buildStructuredApiError(
          GATEWAY_RESTART_FAILED_ERROR_CODE,
          'OpenClaw gateway restart is still running.'
        ),
        restart: getGatewayRestartSnapshot(),
      });
    }

    resetGatewayRestartSnapshot();
    res.json({
      success: true,
      restart: getGatewayRestartSnapshot(),
    });
  });

  app.post('/api/config/browser-headed-mode', requireAdminAuth, (req, res) => {
    const { headedModeEnabled } = req.body ?? {};
    if (typeof headedModeEnabled !== 'boolean') {
      return res.status(400).json(buildStructuredApiError(
        BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
        'headedModeEnabled must be a boolean'
      ));
    }

    void (async () => {
      try {
        const currentConfig = readBrowserHeadedModeConfig();
        if (currentConfig.headedModeEnabled === headedModeEnabled) {
          return res.json({
            success: true,
            config: currentConfig,
            restartCompleted: false,
          });
        }

        const previousRuntimeState = await readOpenClawGatewayServiceRuntimeState();
        const config = setBrowserHeadedModeEnabled(headedModeEnabled);
        const restart = runTrackedGatewayRestart({
          trigger: 'browser-headed-mode',
          previousRuntimeState,
          targetHeadedModeEnabled: headedModeEnabled,
        });

        res.json({
          success: true,
          config,
          restartCompleted: false,
          restart,
        });
      } catch (error: any) {
        res.status(500).json({
          ...buildStructuredApiError(
            BROWSER_HEADED_MODE_UPDATE_FAILED_ERROR_CODE,
            error?.message || 'Failed to update browser headed mode config'
          ),
          restart: getGatewayRestartSnapshot(),
        });
      }
    })();
  });

  app.post('/api/config/browser-health/self-heal', requireAdminAuth, async (_req, res) => {
    let taskStarted = false;
    try {
      const lastKnownIssue = _req.body?.lastKnownIssue;
      ensureBrowserTaskIdle();
      updateBrowserTaskSnapshot({
        status: 'repairing',
        phase: 'inspect-current',
        rawDetail: null,
      });
      taskStarted = true;

      const reportRepairProgress = (phase: string, rawDetail?: string | null) => {
        updateBrowserTaskSnapshot({
          status: 'repairing',
          phase,
          rawDetail: normalizeCliText(rawDetail) || null,
        });
      };

      reportRepairProgress('enable-permissions');
      await configureMaxPermissionsState(true);
      reportRepairProgress('sync-browser-settings');
      synchronizeConfiguredBrowserRepairSettings();
      reportRepairProgress('refresh-plugins');
      try {
        await refreshOpenClawPluginRegistryForBrowserSelfHeal();
      } catch (error) {
        reportRepairProgress('refresh-plugins', readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error)));
      }
      reportRepairProgress('restart-gateway');
      await restartGatewayService();
      await waitForBrowserGatewayReady(BROWSER_SELF_HEAL_GATEWAY_READY_TIMEOUT_MS, reportRepairProgress);
      reportRepairProgress('stop-browser');
      await stopOpenClawBrowserBestEffort();

      const shouldResetProfile = shouldRetryBrowserRepairWithProfileReset(
        lastKnownIssue === 'permissions'
        || lastKnownIssue === 'disabled'
        || lastKnownIssue === 'stopped'
        || lastKnownIssue === 'detect-error'
        || lastKnownIssue === 'timeout'
        || lastKnownIssue === 'unknown'
          ? lastKnownIssue
          : null
      );

      if (shouldResetProfile) {
        reportRepairProgress('reset-profile');
        await stopOpenClawBrowserBestEffort();
        await resetOpenClawBrowserProfile();
      }

      reportRepairProgress('finalize');
      const health = await runBrowserHealthCheck(reportRepairProgress);

      res.json({
        success: true,
        gatewayRestarted: true,
        resetProfile: shouldResetProfile,
        health,
      });
    } catch (error: any) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }
      res.json(buildStructuredApiError(
        BROWSER_SELF_HEAL_FAILED_ERROR_CODE,
        readCliErrorDetail(error) || error?.message || 'Browser self-heal failed'
      ));
    } finally {
      if (taskStarted) {
        resetBrowserTaskSnapshot();
      }
    }
  });

  app.get('/api/config/max-permissions', async (_req, res) => {
    const enabled = readMaxPermissionsEnabled() === true;
    const [hostTakeover, devicePairing] = await Promise.all([
      safeReadHostTakeoverStatus(enabled),
      safeReadDevicePairingStatus(),
    ]);
    res.json({ enabled, hostTakeover, devicePairing });
  });

  app.post('/api/config/max-permissions', requireAdminAuth, async (req, res) => {
    const requestedEnabled = Boolean(req.body?.enabled);
    const systemPassword = normalizeCliText(req.body?.systemPassword) || null;

    try {
      const result = await configureMaxPermissionsState(requestedEnabled, { systemPassword });
      const devicePairing = await safeReadDevicePairingStatus();
      res.json({
        success: true,
        enabled: result.enabled,
        restartRequired: true,
        hostTakeover: result.hostTakeover,
        devicePairing,
      });
    } catch (error: any) {
      const currentEnabled = readMaxPermissionsEnabled() === true;
      const [hostTakeover, devicePairing] = await Promise.all([
        safeReadHostTakeoverStatus(requestedEnabled || currentEnabled),
        safeReadDevicePairingStatus(),
      ]);
      hostTakeover.enabled = currentEnabled;

      if (isStructuredRequestError(error)) {
        return res.status(error.status).json({
          ...error.payload,
          enabled: currentEnabled,
          hostTakeover,
          devicePairing,
        });
      }

      res.status(500).json({
        ...buildStructuredApiError(
          GATEWAY_MAX_PERMISSIONS_UPDATE_FAILED_ERROR_CODE,
          readCliErrorDetail(error) || error?.message || 'Failed to update maximum permissions.'
        ),
        enabled: currentEnabled,
        hostTakeover,
        devicePairing,
      });
    }
  });

  app.post('/api/config/max-permissions/device-pairing/approve', requireAdminAuth, async (_req, res) => {
    try {
      const result = await approveLatestDevicePairingRequest();
      res.json({
        success: true,
        approvedRequestId: result.approvedRequestId,
        approvedDeviceId: result.approvedDeviceId,
        approvedDeviceName: result.approvedDeviceName,
        devicePairing: result.devicePairing,
      });
    } catch (error: any) {
      if (isStructuredRequestError(error)) {
        return res.status(error.status).json(error.payload);
      }

      res.status(500).json(buildStructuredApiError(
        GATEWAY_DEVICE_PAIRING_APPROVE_FAILED_ERROR_CODE,
        readCliErrorDetail(error) || error?.message || 'Failed to approve the latest device pairing request.',
      ));
    }
  });

  app.post('/api/config/restart', requireAdminAuth, async (_req, res) => {
    try {
      const previousRuntimeState = await readOpenClawGatewayServiceRuntimeState();
      const restart = runTrackedGatewayRestart({
        trigger: 'gateway',
        previousRuntimeState,
      });

      res.json({
        success: true,
        message: 'Gateway restart started',
        restart,
      });
    } catch (error: any) {
      console.error('Failed to restart gateway:', error);
      res.status(500).json({
        ...buildStructuredApiError(GATEWAY_RESTART_FAILED_ERROR_CODE, error?.message),
        restart: getGatewayRestartSnapshot(),
      });
    }
  });
}
