import { apiFetch, jsonInit } from './client';

// 配置接口只回 `hasXxx` 布尔位，凭据值永远不下发；写入时空串视为「不修改」。

export function getConfig() {
  return apiFetch('/config');
}

/** 局部更新配置（POST 语义是合并，不是覆盖）。 */
export function saveConfig(body: unknown) {
  return apiFetch('/config', jsonInit('POST', body));
}

export function testGatewayConfig(body: unknown) {
  return apiFetch('/config/test', jsonInit('POST', body));
}

export function detectAllConfig() {
  return apiFetch('/config/detect-all');
}

export function restartGateway() {
  return apiFetch('/config/restart', { method: 'POST' });
}

export function getGatewayRestartStatus() {
  return apiFetch('/config/restart/status');
}

export function resetGatewayRestartStatus() {
  return apiFetch('/config/restart/status/reset', { method: 'POST' });
}

export function getBrowserHeadedMode() {
  return apiFetch('/config/browser-headed-mode');
}

export function saveBrowserHeadedMode(body: unknown) {
  return apiFetch('/config/browser-headed-mode', jsonInit('POST', body));
}

export function getMaxPermissions() {
  return apiFetch('/config/max-permissions');
}

export function saveMaxPermissions(body: unknown) {
  return apiFetch('/config/max-permissions', jsonInit('POST', body));
}

export function approveLatestDevicePairing() {
  return apiFetch('/config/max-permissions/device-pairing/approve', { method: 'POST' });
}

export function checkBrowserHealth() {
  return apiFetch('/config/browser-health');
}

export function getBrowserHealthTaskStatus() {
  return apiFetch('/config/browser-health/status');
}

export function selfHealBrowser(body: unknown) {
  return apiFetch('/config/browser-health/self-heal', jsonInit('POST', body));
}
