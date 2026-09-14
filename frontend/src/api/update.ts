import { apiFetch, jsonInit } from './client';

// ClawOPT 自身与 OpenClaw runtime 的版本查询和升级状态机。

export function getVersion() {
  return apiFetch('/version');
}

export function getLatestVersion() {
  return apiFetch('/version/latest');
}

export function getUpdateStatus() {
  return apiFetch('/update/status');
}

export function startUpdate() {
  return apiFetch('/update/start', jsonInit('POST', {}));
}

export function cancelUpdate() {
  return apiFetch('/update/cancel', jsonInit('POST', {}));
}

export function resetUpdate() {
  return apiFetch('/update/reset', jsonInit('POST', {}));
}

export function restartUpdatedService() {
  return apiFetch('/update/restart-service', jsonInit('POST', {}));
}

export function getOpenClawLatestVersion() {
  return apiFetch('/openclaw/version/latest');
}

export function getOpenClawUpdateStatus() {
  return apiFetch('/openclaw/update/status');
}

export function startOpenClawUpdate() {
  return apiFetch('/openclaw/update/start', jsonInit('POST', {}));
}

export function cancelOpenClawUpdate() {
  return apiFetch('/openclaw/update/cancel', jsonInit('POST', {}));
}

export function resetOpenClawUpdate() {
  return apiFetch('/openclaw/update/reset', jsonInit('POST', {}));
}
