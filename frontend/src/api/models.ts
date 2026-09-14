import { apiFetch, apiJsonWithTimeout, jsonInit } from './client';

export function listModels() {
  return apiFetch('/models');
}

/** 应用级模型列表轮询；超时即放弃，调用方按原样 catch。 */
export function listModelsWithTimeout(timeoutMs: number) {
  return apiJsonWithTimeout<{ success?: boolean; models?: any[] }>('/models', timeoutMs);
}

export function getModelFallbacks() {
  return apiFetch('/models/fallbacks');
}

export function saveModelFallbacks(body: unknown) {
  return apiFetch('/models/fallbacks', jsonInit('PUT', body));
}

export function getImageGenerationModel() {
  return apiFetch('/models/image-generation');
}

export function saveImageGenerationModel(body: unknown) {
  return apiFetch('/models/image-generation', jsonInit('PUT', body));
}

export function discoverModels(endpointId: string, signal?: AbortSignal) {
  return apiFetch(`/models/discover?endpoint=${encodeURIComponent(endpointId)}`, { signal });
}

/** 生图模型走独立的测试接口：普通对话测试会把生图模型误判为不可用。 */
export function testModel(body: unknown, options: { imageGeneration: boolean; signal?: AbortSignal }) {
  const path = options.imageGeneration ? '/models/test-image-generation' : '/models/test';
  return apiFetch(path, jsonInit('POST', body, options.signal ? { signal: options.signal } : undefined));
}

export function addModel(body: unknown) {
  return apiFetch('/models/manage', jsonInit('POST', body));
}

export function updateModel(body: unknown) {
  return apiFetch('/models/manage', jsonInit('PUT', body));
}

export function deleteModel(body: unknown) {
  return apiFetch('/models/manage', jsonInit('DELETE', body));
}

export function setDefaultModel(body: unknown) {
  return apiFetch('/models/manage/default', jsonInit('PUT', body));
}
