// 升级与浏览器任务各阶段对应的进度百分比与文案 key。
import type { BrowserTaskPhaseVisual, UpdatePhaseVisual } from './settingsTypes';

export const UPDATE_PHASE_VISUALS: Record<string, UpdatePhaseVisual> = {
  'downloading-script': { progress: 10, labelKey: 'settings.about.updateProgressFetchingCode' },
  'detect-service': { progress: 18, labelKey: 'settings.about.updateProgressPreparing' },
  'git-pull': { progress: 26, labelKey: 'settings.about.updateProgressFetchingCode' },
  'install-dependencies': { progress: 40, labelKey: 'settings.about.updateProgressInstallingDependencies' },
  'build': { progress: 58, labelKey: 'settings.about.updateProgressBuilding' },
  'patch-config': { progress: 68, labelKey: 'settings.about.updateProgressApplyingConfig' },
  'restart-openclaw-runtime': { progress: 86, labelKey: 'settings.about.updateProgressRestartingOpenClaw' },
  'reconcile-openclaw-runtime': { progress: 78, labelKey: 'settings.about.updateProgressReconcilingRuntime' },
  'repair-openclaw-device': { progress: 86, labelKey: 'settings.about.updateProgressRepairingDevice' },
  'recover-browser-runtime': { progress: 92, labelKey: 'settings.about.updateProgressRecoveringBrowser' },
  'setup-service': { progress: 96, labelKey: 'settings.about.updateProgressSettingUpService' },
  'service-restart': { progress: 98, labelKey: 'settings.about.updateProgressSettingUpService' },
  'restart-openclaw': { progress: 99, labelKey: 'settings.about.restartStepRestartOpenClaw' },
  'restart-project': { progress: 99, labelKey: 'settings.about.restartStepRestartProject' },
  'warmup-browser': { progress: 100, labelKey: 'settings.about.restartStepWarmupBrowser' },
  'complete': { progress: 100, labelKey: 'settings.about.updateProgressFinishing' },
};

export const OPENCLAW_UPDATE_PHASE_VISUALS: Record<string, UpdatePhaseVisual> = {
  'checking-status': { progress: 12, labelKey: 'settings.openclawUpdate.progressChecking' },
  'download-package': { progress: 28, labelKey: 'settings.openclawUpdate.progressDownloading' },
  'install-package': { progress: 52, labelKey: 'settings.openclawUpdate.progressInstalling' },
  'switch-command-entrypoint': { progress: 72, labelKey: 'settings.openclawUpdate.progressSwitchingEntrypoint' },
  'finalize-update': { progress: 84, labelKey: 'settings.openclawUpdate.progressFinalizingPackage' },
  'running-update': { progress: 52, labelKey: 'settings.openclawUpdate.progressInstalling' },
  'stopping-update': { progress: 72, labelKey: 'settings.openclawUpdate.progressStopping' },
  'repair-command-entrypoint': { progress: 92, labelKey: 'settings.openclawUpdate.progressRepairingEntrypoint' },
  'verifying-version': { progress: 96, labelKey: 'settings.openclawUpdate.progressVerifying' },
  'complete': { progress: 100, labelKey: 'settings.openclawUpdate.progressFinishing' },
};

export const BROWSER_CHECK_PHASE_VISUALS: Record<string, BrowserTaskPhaseVisual> = {
  'read-config': { progress: 12, labelKey: 'settings.gateway.browserTaskPhases.readConfig' },
  'wait-gateway': { progress: 22, labelKey: 'settings.gateway.browserTaskPhases.waitGateway' },
  'read-status': { progress: 32, labelKey: 'settings.gateway.browserTaskPhases.readStatus' },
  'start-browser': { progress: 52, labelKey: 'settings.gateway.browserTaskPhases.startBrowser' },
  'wait-running': { progress: 68, labelKey: 'settings.gateway.browserTaskPhases.waitRunning' },
  'open-validation': { progress: 84, labelKey: 'settings.gateway.browserTaskPhases.openValidation' },
  'capture-snapshot': { progress: 94, labelKey: 'settings.gateway.browserTaskPhases.captureSnapshot' },
  'finalize': { progress: 100, labelKey: 'settings.gateway.browserTaskPhases.finalizeCheck' },
};

export const BROWSER_REPAIR_PHASE_VISUALS: Record<string, BrowserTaskPhaseVisual> = {
  'inspect-current': { progress: 8, labelKey: 'settings.gateway.browserTaskPhases.inspectCurrent' },
  'read-config': { progress: 18, labelKey: 'settings.gateway.browserTaskPhases.readConfig' },
  'read-status': { progress: 28, labelKey: 'settings.gateway.browserTaskPhases.readStatus' },
  'enable-permissions': { progress: 42, labelKey: 'settings.gateway.browserTaskPhases.enablePermissions' },
  'sync-browser-settings': { progress: 52, labelKey: 'settings.gateway.browserTaskPhases.syncBrowserSettings' },
  'refresh-plugins': { progress: 56, labelKey: 'settings.gateway.browserTaskPhases.refreshPlugins' },
  'restart-gateway': { progress: 60, labelKey: 'settings.gateway.browserTaskPhases.restartGateway' },
  'wait-gateway': { progress: 66, labelKey: 'settings.gateway.browserTaskPhases.waitGateway' },
  'stop-browser': { progress: 72, labelKey: 'settings.gateway.browserTaskPhases.stopBrowser' },
  'start-browser': { progress: 82, labelKey: 'settings.gateway.browserTaskPhases.startBrowser' },
  'wait-running': { progress: 90, labelKey: 'settings.gateway.browserTaskPhases.waitRunning' },
  'reset-profile': { progress: 96, labelKey: 'settings.gateway.browserTaskPhases.resetProfile' },
  'open-validation': { progress: 96, labelKey: 'settings.gateway.browserTaskPhases.openValidation' },
  'capture-snapshot': { progress: 99, labelKey: 'settings.gateway.browserTaskPhases.captureSnapshot' },
  'finalize': { progress: 100, labelKey: 'settings.gateway.browserTaskPhases.finalizeRepair' },
};
