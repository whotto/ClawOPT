import { apiFetch, jsonInit } from './client';

// 预设装配（/presets）与 .clawpack 可移植包（/packs）。

export function listPresets() {
  return apiFetch('/presets');
}

export function installPreset(presetId: string, body: unknown) {
  return apiFetch(`/presets/${presetId}/install`, jsonInit('POST', body));
}

export function exportPack(body: unknown) {
  return apiFetch('/packs/export', jsonInit('POST', body));
}

export function sharePack(body: unknown) {
  return apiFetch('/packs/share', jsonInit('POST', body));
}

/** 包来源二选一：本地文件走 multipart，远端 URL 走 JSON。调用方构造好 body。 */
export type PackSource = { kind: 'file'; form: FormData } | { kind: 'json'; body: unknown };

function packInit(source: PackSource): RequestInit {
  return source.kind === 'file'
    ? { method: 'POST', body: source.form }
    : jsonInit('POST', source.body);
}

export function inspectPack(source: PackSource) {
  return apiFetch('/packs/inspect', packInit(source));
}

export function installPack(source: PackSource) {
  return apiFetch('/packs/install', packInit(source));
}
