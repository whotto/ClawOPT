import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

import { normalizeGroupToolProgressLocale } from '../../collab/rooms';
import type { ConfigManager } from '../../core/config';
import type { CapabilityCacheRow, DB } from '../../core/db';
import { execFilePromise, readCliErrorDetail } from '../../core/process';
import { normalizeCliText } from '../../core/util';
import { ensureResolvedOpenClawExecutablePath } from '../../openclaw';
import type {
  AgentProvisioner,
  ImageGenerationEndpointModelSnapshot,
} from '../agents/agent-provisioner';
import { shouldUseConfiguredImageGenerationModel } from './image-generation-routing';

type OpenClawImageProviderEntry = {
  id: string;
  label: string;
  available: boolean;
  configured: boolean;
  selected: boolean;
  defaultModel: string | null;
  models: string[];
  capabilities: Record<string, any>;
};

type OpenClawImageProviderSnapshot = {
  providers: OpenClawImageProviderEntry[];
  models: Array<{
    id: string;
    alias: string;
    providerId: string;
    providerLabel: string;
    model: string;
    available: boolean;
    configured: boolean;
    selected: boolean;
    input: string[];
  }>;
  updatedAt: string;
  cache?: {
    source: 'database' | 'openclaw';
    status: 'success' | 'error';
    updatedAt: string | null;
    openclawVersion: string | null;
    errorDetail: string | null;
  };
};

const IMAGE_PROVIDER_CACHE_KEY = 'image_generation_providers';
const IMAGE_PROVIDER_LIST_TIMEOUT_MS = 45000;
const IMAGE_GENERATION_TIMEOUT_MS = 600000;
const SUPPORTED_IMAGE_ASPECT_RATIOS = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);

type DirectImageGenerationResult = {
  content: string;
  processContent: string;
  modelUsed: string;
  imagePath: string;
};

function parseCliJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('OpenClaw image provider list returned no JSON output.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const firstArray = trimmed.indexOf('[');
  const lastArray = trimmed.lastIndexOf(']');
  if (firstArray !== -1 && lastArray > firstArray) {
    return JSON.parse(trimmed.slice(firstArray, lastArray + 1));
  }

  const firstObject = trimmed.indexOf('{');
  const lastObject = trimmed.lastIndexOf('}');
  if (firstObject !== -1 && lastObject > firstObject) {
    return JSON.parse(trimmed.slice(firstObject, lastObject + 1));
  }

  throw new Error('OpenClaw image provider list did not contain parseable JSON.');
}

async function runOpenClawImageProviderListCli(timeoutMs = IMAGE_PROVIDER_LIST_TIMEOUT_MS): Promise<unknown> {
  const executablePath = await ensureResolvedOpenClawExecutablePath();
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, ['infer', 'image', 'providers', '--json'], {
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const signalChildGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };

    const terminateChildGroup = () => {
      signalChildGroup('SIGTERM');
      killTimer = setTimeout(() => signalChildGroup('SIGKILL'), 1000);
      killTimer.unref();
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    const finishSuccess = (value: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateChildGroup();
      resolve(value);
    };

    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateChildGroup();
      reject(error);
    };

    const tryFinishFromStdout = () => {
      try {
        finishSuccess(parseCliJsonOutput(stdout));
      } catch {}
    };

    const timer = setTimeout(() => {
      try {
        finishSuccess(parseCliJsonOutput(stdout));
        return;
      } catch {}

      timedOut = true;
      signalChildGroup('SIGTERM');
      killTimer = setTimeout(() => signalChildGroup('SIGKILL'), 35000);
      killTimer.unref();
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) {
        finishError(new Error('OpenClaw image provider list output is too large.'));
        return;
      }
      tryFinishFromStdout();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) {
        stderr = stderr.slice(-1024 * 1024);
      }
    });

    child.on('error', (error) => {
      finishError(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      try {
        finishSuccess(parseCliJsonOutput(stdout));
        return;
      } catch {}

      const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
      finishError(new Error(timedOut
        ? `OpenClaw image provider list timed out. ${detail}`
        : `OpenClaw image provider list failed: ${detail}`));
    });
  });
}

function normalizeImageProviderSnapshot(raw: unknown): OpenClawImageProviderSnapshot {
  const entries: any[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as any)?.providers)
      ? (raw as any).providers
      : [];

  const providers: OpenClawImageProviderEntry[] = entries
    .map((entry: any) => {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id) return null;
      const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : id;
      const models: string[] = Array.isArray(entry?.models)
        ? Array.from(new Set(entry.models.filter((model: unknown): model is string => typeof model === 'string' && model.trim().length > 0).map((model: string) => model.trim())))
        : [];
      return {
        id,
        label,
        available: entry?.available !== false,
        configured: entry?.configured === true,
        selected: entry?.selected === true,
        defaultModel: typeof entry?.defaultModel === 'string' && entry.defaultModel.trim() ? entry.defaultModel.trim() : null,
        models,
        capabilities: entry?.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {},
      };
    })
    .filter((entry): entry is OpenClawImageProviderEntry => Boolean(entry));

  const models = providers.flatMap((provider) => provider.models.map((model) => ({
    id: `${provider.id}/${model}`,
    alias: `${provider.label} / ${model}`,
    providerId: provider.id,
    providerLabel: provider.label,
    model,
    available: provider.available,
    configured: provider.configured,
    selected: provider.selected,
    input: ['image_generation'],
  })));

  return {
    providers,
    models,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeImageProviderCacheMeta(row: CapabilityCacheRow): OpenClawImageProviderSnapshot['cache'] {
  return {
    source: 'database',
    status: row.status === 'error' ? 'error' : 'success',
    updatedAt: normalizeCliText(row.updated_at) || null,
    openclawVersion: normalizeCliText(row.openclaw_version) || null,
    errorDetail: normalizeCliText(row.error_detail) || null,
  };
}

function parseCachedOpenClawImageProviderSnapshot(row: CapabilityCacheRow | undefined): OpenClawImageProviderSnapshot | null {
  if (!row) return null;

  try {
    const parsed = JSON.parse(row.value) as Partial<OpenClawImageProviderSnapshot>;
    if (!Array.isArray(parsed.providers) || !Array.isArray(parsed.models)) {
      return null;
    }

    return {
      providers: parsed.providers as OpenClawImageProviderEntry[],
      models: parsed.models as OpenClawImageProviderSnapshot['models'],
      updatedAt: normalizeCliText(parsed.updatedAt) || normalizeCliText(row.updated_at) || new Date().toISOString(),
      cache: normalizeImageProviderCacheMeta(row),
    };
  } catch {
    return null;
  }
}

async function readOpenClawVersionForImageProviderCache(): Promise<string | null> {
  try {
    const executablePath = await ensureResolvedOpenClawExecutablePath();
    const { stdout } = await execFilePromise(executablePath, ['--version'], {
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    const raw = normalizeCliText(stdout);
    const matched = raw.match(/OpenClaw\s+([^\s(]+)/i);
    return matched?.[1] || raw || null;
  } catch {
    return null;
  }
}

function buildInlineLocalFileUrl(absolutePath: string): string {
  const encodedPath = Buffer.from(absolutePath).toString('base64');
  return `/api/files/download?path=${encodeURIComponent(encodedPath)}&disposition=inline`;
}

function buildImageGenerationOutputPath(outputDir: string): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 10);
  return path.join(outputDir, `image-${safeTimestamp}-${suffix}.png`);
}

function resolveImageGenerationAspectRatioHint(prompt: string): string | null {
  const normalized = prompt.replace(/[：]/g, ':');
  const ratioMatch = normalized.match(/(?:^|[^\d])(\d{1,2}\s*:\s*\d{1,2})(?=$|[^\d])/);
  if (!ratioMatch) return null;

  const ratio = ratioMatch[1].replace(/\s+/g, '');
  return SUPPORTED_IMAGE_ASPECT_RATIOS.has(ratio) ? ratio : null;
}

function resolveImageGenerationSize(prompt: string): string {
  const aspectRatio = resolveImageGenerationAspectRatioHint(prompt);
  if (aspectRatio === '1:1') return '1024x1024';
  if (aspectRatio === '3:2' || aspectRatio === '4:3' || aspectRatio === '5:4' || aspectRatio === '16:9' || aspectRatio === '21:9') {
    return '1536x1024';
  }
  if (aspectRatio === '2:3' || aspectRatio === '3:4' || aspectRatio === '4:5' || aspectRatio === '9:16') {
    return '1024x1536';
  }
  return '1024x1024';
}

function buildImageGenerationRequestUrl(endpoint: ImageGenerationEndpointModelSnapshot): string {
  return `${endpoint.baseUrl.replace(/\/+$/, '')}/images/generations`;
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function buildImageGenerationRequestHeaders(endpoint: ImageGenerationEndpointModelSnapshot): Record<string, string> {
  const headers: Record<string, string> = {
    ...(endpoint.headers || {}),
    'Content-Type': 'application/json',
  };

  const authHeader = endpoint.authHeader || 'Authorization';
  if (!hasHeader(headers, authHeader)) {
    headers[authHeader] = authHeader.toLowerCase() === 'authorization'
      ? `Bearer ${endpoint.apiKey}`
      : endpoint.apiKey;
  }

  return headers;
}

function sanitizeImageGenerationErrorDetail(detail: string, endpoint?: ImageGenerationEndpointModelSnapshot): string {
  const normalized = normalizeCliText(detail);
  if (!normalized) return 'Image generation request failed.';

  let sanitized = normalized;
  const secret = endpoint?.apiKey;
  if (secret && secret.length >= 6) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }

  return sanitized.length > 2000 ? `${sanitized.slice(0, 2000)}...` : sanitized;
}

function getHttpErrorResponse(error: any): { status?: number; statusText?: string; data?: unknown } | null {
  if (axios.isAxiosError(error)) {
    return error.response || null;
  }
  if (error?.response && typeof error.response === 'object') {
    return error.response;
  }
  return null;
}

function extractImageGenerationErrorDetail(error: any, endpoint?: ImageGenerationEndpointModelSnapshot): string {
  const response = getHttpErrorResponse(error);
  if (response) {
    const status = response.status;
    const statusText = normalizeCliText(response.statusText);
    const data = response.data;
    const bodyText = (() => {
      if (!data) return '';
      if (typeof data === 'string') return data;
      if (data instanceof Buffer) return data.toString('utf8');
      const message = normalizeCliText((data as any)?.error?.message)
        || normalizeCliText((data as any)?.message)
        || normalizeCliText((data as any)?.detail)
        || normalizeCliText((data as any)?.error);
      return message || JSON.stringify(data);
    })();

    if (status) {
      return sanitizeImageGenerationErrorDetail(
        `HTTP ${status}${statusText ? ` ${statusText}` : ''}${bodyText ? ` - ${bodyText}` : ''}`,
        endpoint,
      );
    }
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED') {
      return `Image generation request timed out after ${IMAGE_GENERATION_TIMEOUT_MS}ms.`;
    }

    return sanitizeImageGenerationErrorDetail(error.message, endpoint);
  }

  return sanitizeImageGenerationErrorDetail(error instanceof Error ? error.message : String(error), endpoint);
}

function isRetryableImageGenerationRequestError(error: any): boolean {
  const status = getHttpErrorResponse(error)?.status;
  return status === 400 || status === 422;
}

function parseBase64ImageData(value: string): Buffer | null {
  const normalized = normalizeCliText(value);
  if (!normalized) return null;

  const dataUriMatch = normalized.match(/^data:[^;]+;base64,(.+)$/i);
  const rawBase64 = dataUriMatch ? dataUriMatch[1] : normalized;
  try {
    const buffer = Buffer.from(rawBase64, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function findGeneratedImageBase64(payload: any): string | null {
  const dataEntries = Array.isArray(payload?.data) ? payload.data : [];
  const imageEntries = Array.isArray(payload?.images) ? payload.images : [];
  const entries = [...dataEntries, ...imageEntries];

  for (const entry of entries) {
    const value = normalizeCliText(entry?.b64_json)
      || normalizeCliText(entry?.base64)
      || normalizeCliText(entry?.image_base64)
      || normalizeCliText(entry?.image?.b64_json)
      || normalizeCliText(entry?.image?.base64);
    if (value) return value;
  }

  return normalizeCliText(payload?.b64_json)
    || normalizeCliText(payload?.base64)
    || normalizeCliText(payload?.image_base64)
    || null;
}

function findGeneratedImageUrl(payload: any): string | null {
  const dataEntries = Array.isArray(payload?.data) ? payload.data : [];
  const imageEntries = Array.isArray(payload?.images) ? payload.images : [];
  const entries = [...dataEntries, ...imageEntries];

  for (const entry of entries) {
    const value = normalizeCliText(entry?.url)
      || normalizeCliText(entry?.image_url?.url)
      || normalizeCliText(entry?.image?.url);
    if (value) return value;
  }

  return normalizeCliText(payload?.url)
    || normalizeCliText(payload?.image_url?.url)
    || null;
}

async function writeGeneratedImageUrlToFile(
  endpoint: ImageGenerationEndpointModelSnapshot,
  imageUrl: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (/^data:[^;]+;base64,/i.test(imageUrl)) {
    const buffer = parseBase64ImageData(imageUrl);
    if (!buffer) throw new Error('Image generation returned an unreadable data URL.');
    fs.writeFileSync(outputPath, buffer);
    return;
  }

  const resolvedUrl = new URL(imageUrl, endpoint.baseUrl).toString();
  const response = await axios.get<ArrayBuffer>(resolvedUrl, {
    responseType: 'arraybuffer',
    timeout: IMAGE_GENERATION_TIMEOUT_MS,
    signal,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Image download failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
  }

  fs.writeFileSync(outputPath, Buffer.from(response.data));
}

async function writeOpenAICompatibleImageResponseToFile(
  endpoint: ImageGenerationEndpointModelSnapshot,
  payload: unknown,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  const base64Image = findGeneratedImageBase64(payload as any);
  if (base64Image) {
    const buffer = parseBase64ImageData(base64Image);
    if (!buffer) throw new Error('Image generation returned unreadable base64 data.');
    fs.writeFileSync(outputPath, buffer);
    return;
  }

  const imageUrl = findGeneratedImageUrl(payload as any);
  if (imageUrl) {
    await writeGeneratedImageUrlToFile(endpoint, imageUrl, outputPath, signal);
    return;
  }

  throw new Error('Image generation completed without image data.');
}

function buildImageGenerationRequestBodies(endpoint: ImageGenerationEndpointModelSnapshot, prompt: string): Array<Record<string, unknown>> {
  const baseBody = {
    model: endpoint.modelName,
    prompt,
    n: 1,
  };
  const size = resolveImageGenerationSize(prompt);

  return [
    { ...baseBody, size, response_format: 'b64_json' },
    { ...baseBody, size },
    { ...baseBody, response_format: 'b64_json' },
    baseBody,
  ];
}

async function generateImageThroughEndpoint(
  endpoint: ImageGenerationEndpointModelSnapshot,
  prompt: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = buildImageGenerationRequestUrl(endpoint);
  const headers = buildImageGenerationRequestHeaders(endpoint);
  let lastError: unknown = null;

  for (const body of buildImageGenerationRequestBodies(endpoint, prompt)) {
    try {
      const response = await axios.post(url, body, {
        headers,
        timeout: IMAGE_GENERATION_TIMEOUT_MS,
        signal,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        const error: any = new Error(`HTTP ${response.status}`);
        error.response = response;
        throw error;
      }

      await writeOpenAICompatibleImageResponseToFile(endpoint, response.data, outputPath, signal);
      if (!fs.existsSync(outputPath)) {
        throw new Error('Image generation completed without a readable output file.');
      }
      return outputPath;
    } catch (error) {
      lastError = error;
      if (!isRetryableImageGenerationRequestError(error)) {
        break;
      }
    }
  }

  throw new Error(extractImageGenerationErrorDetail(lastError, endpoint));
}

export function findImageProviderModel(snapshot: OpenClawImageProviderSnapshot, modelRef: string) {
  const normalizedRef = modelRef.trim();
  if (!normalizedRef) return null;
  return snapshot.models.find((model) => model.id === normalizedRef) || null;
}

function collectImageProviderModelNameCandidates(value: string): string[] {
  const normalizedName = value.trim().replace(/^\/+|\/+$/g, '');
  if (!normalizedName) return [];

  const candidates = [normalizedName];
  const firstSlashIndex = normalizedName.indexOf('/');
  if (firstSlashIndex >= 0) {
    const suffix = normalizedName.slice(firstSlashIndex + 1).replace(/^\/+|\/+$/g, '');
    if (suffix) {
      candidates.push(suffix);
    }
  }

  const lastSlashIndex = normalizedName.lastIndexOf('/');
  if (lastSlashIndex > firstSlashIndex) {
    const suffix = normalizedName.slice(lastSlashIndex + 1).replace(/^\/+|\/+$/g, '');
    if (suffix) {
      candidates.push(suffix);
    }
  }

  return Array.from(new Set(candidates));
}

export function findImageProviderModelByName(snapshot: OpenClawImageProviderSnapshot, modelName: string) {
  const candidates = collectImageProviderModelNameCandidates(modelName);
  if (candidates.length === 0) return null;
  return snapshot.models.find((model) => candidates.includes(model.model)) || null;
}

export function summarizeImageProviderModels(snapshot: OpenClawImageProviderSnapshot, limit = 16): string {
  const ids = snapshot.models.map((model) => model.id);
  if (ids.length === 0) return 'No image generation models were reported by OpenClaw.';
  const visible = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${visible}, ...` : visible;
}

export type ImageGenerationServiceDeps = {
  agentProvisioner: AgentProvisioner;
  configManager: ConfigManager;
  db: DB;
};

export function createImageGenerationService(ctx: ImageGenerationServiceDeps) {
  const { agentProvisioner, configManager, db } = ctx;

  let imageProviderListRefreshInFlight: Promise<OpenClawImageProviderSnapshot> | null = null;

  function readCachedOpenClawImageProviderSnapshot(): OpenClawImageProviderSnapshot | null {
    return parseCachedOpenClawImageProviderSnapshot(db.getCapabilityCache(IMAGE_PROVIDER_CACHE_KEY));
  }

  async function refreshOpenClawImageProviderSnapshot(): Promise<OpenClawImageProviderSnapshot> {
    if (imageProviderListRefreshInFlight) {
      return imageProviderListRefreshInFlight;
    }

    imageProviderListRefreshInFlight = (async () => {
      const openclawVersion = await readOpenClawVersionForImageProviderCache();
      try {
        const raw = await runOpenClawImageProviderListCli();
        const snapshot = normalizeImageProviderSnapshot(raw);
        db.upsertCapabilityCache({
          key: IMAGE_PROVIDER_CACHE_KEY,
          value: JSON.stringify(snapshot),
          openclawVersion,
          status: 'success',
          errorDetail: null,
        });
        return {
          ...snapshot,
          cache: {
            source: 'openclaw' as const,
            status: 'success' as const,
            updatedAt: snapshot.updatedAt,
            openclawVersion,
            errorDetail: null,
          },
        };
      } catch (error) {
        const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
        db.markCapabilityCacheError(IMAGE_PROVIDER_CACHE_KEY, detail, openclawVersion);
        throw error;
      }
    })().finally(() => {
      imageProviderListRefreshInFlight = null;
    });

    return imageProviderListRefreshInFlight;
  }

  async function readOpenClawImageProviderSnapshot(options?: {
    refresh?: boolean;
    allowStaleOnError?: boolean;
  }): Promise<OpenClawImageProviderSnapshot> {
    if (!options?.refresh) {
      const cached = readCachedOpenClawImageProviderSnapshot();
      if (cached) {
        return cached;
      }
    }

    try {
      return await refreshOpenClawImageProviderSnapshot();
    } catch (error) {
      if (options?.allowStaleOnError !== false) {
        const cached = readCachedOpenClawImageProviderSnapshot();
        if (cached) {
          return cached;
        }
      }
      throw error;
    }
  }

  function getConfiguredDirectImageGenerationModel(): string | null {
    const candidates = getConfiguredDirectImageGenerationCandidates();
    return candidates[0] || null;
  }

  function getConfiguredDirectImageGenerationCandidates(): string[] {
    const config = agentProvisioner.readImageGenerationModelConfig();
    const primary = normalizeCliText(config.primary);
    if (!primary) return [];

    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const modelId of [primary, ...config.fallbacks]) {
      const normalized = normalizeCliText(modelId);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      candidates.push(normalized);
    }
    return candidates;
  }

  function buildImageGenerationStartProcessContent(modelId: string): string {
    const locale = normalizeGroupToolProgressLocale(configManager.getConfig().language);
    if (locale === 'en') {
      return `Calling image generation model: ${modelId}`;
    }
    if (locale === 'zh-TW') {
      return `正在呼叫圖像生成模型：${modelId}`;
    }
    return `正在调用图像生成模型：${modelId}`;
  }

  function buildImageGenerationProcessContent(modelId: string, imagePath: string): string {
    const locale = normalizeGroupToolProgressLocale(configManager.getConfig().language);
    if (locale === 'en') {
      return `Calling image generation model: ${modelId}\nImage generated: ${imagePath}`;
    }
    if (locale === 'zh-TW') {
      return `正在呼叫圖像生成模型：${modelId}\n圖像已生成：${imagePath}`;
    }
    return `正在调用图像生成模型：${modelId}\n图像已生成：${imagePath}`;
  }

  async function tryGenerateImageForPrompt(params: {
    prompt: string;
    intentText?: string;
    intentContext?: Array<string | null | undefined> | string | null;
    outputDir: string;
    signal?: AbortSignal;
  }): Promise<DirectImageGenerationResult | null> {
    const candidates = getConfiguredDirectImageGenerationCandidates();
    if (candidates.length === 0) {
      return null;
    }

    const intentText = normalizeCliText(params.intentText) || params.prompt;
    if (!shouldUseConfiguredImageGenerationModel(intentText, params.intentContext)) {
      return null;
    }

    const prompt = normalizeCliText(params.prompt);
    if (!prompt) {
      return null;
    }

    const outputPath = buildImageGenerationOutputPath(params.outputDir);
    const attempts: string[] = [];

    for (const modelId of candidates) {
      const endpoint = agentProvisioner.readImageGenerationEndpointModel(modelId);
      if (!endpoint) {
        attempts.push(`${modelId}: endpoint configuration is incomplete.`);
        continue;
      }

      try {
        if (fs.existsSync(outputPath)) fs.rmSync(outputPath, { force: true });
        const imagePath = await generateImageThroughEndpoint(endpoint, prompt, outputPath, params.signal);
        const filename = path.basename(imagePath);
        return {
          content: `![${filename}](${buildInlineLocalFileUrl(imagePath)})`,
          processContent: buildImageGenerationProcessContent(modelId, imagePath),
          modelUsed: modelId,
          imagePath,
        };
      } catch (error: any) {
        attempts.push(`${modelId}: ${extractImageGenerationErrorDetail(error, endpoint)}`);
      }
    }

    const detail = attempts.length > 0
      ? `Image generation failed. ${attempts.join(' | ')}`
      : 'Image generation failed.';
    const nextError = new Error(detail);
    (nextError as Error & { rawDetail?: string }).rawDetail = detail;
    throw nextError;
  }

  function scheduleOpenClawImageProviderCacheRefresh(reason: string) {
    refreshOpenClawImageProviderSnapshot().catch((error) => {
      const detail = readCliErrorDetail(error) || (error instanceof Error ? error.message : String(error));
      console.warn(`[OpenClawImageProviders] Failed to refresh provider cache during ${reason}: ${detail}`);
    });
  }

  return {
    readOpenClawImageProviderSnapshot,
    getConfiguredDirectImageGenerationModel,
    buildImageGenerationStartProcessContent,
    tryGenerateImageForPrompt,
    scheduleOpenClawImageProviderCacheRefresh,
  };
}
export type ImageGenerationService = ReturnType<typeof createImageGenerationService>;
