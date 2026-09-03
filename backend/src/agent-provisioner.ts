import fs from 'fs';
import { writeJsonAtomicSync } from './config-atomic-write';
import {
  ConfigReadError,
  readJsonConfigSafe,
  assertRegularFile,
  readOpenClawConfigSafe,
  sanitizeErrorDetail,
} from './openclaw-config';
import path from 'path';
import os from 'os';
import type { AgentSystemPromptMode, AgentToolMode } from './db';

/**
 * `openclaw.json` 读不动时抛出的结构化失败。形状照抄 `served-paths.ts` 的判词——
 * 调用方要能在 `reason` 上分辨"文件读不了"和"内容不是合法 JSON"是两件不同的事，
 * 而不是塌成同一个 `null`（那正是 S1-A1 修的缺陷：塌成 null 会被上游误判成
 * "没有变化"，装配报成功，Agent 却从未写进配置）。
 */
// 配置读取的判据全部搬进 `openclaw-config.ts`——那是全仓库唯一的读取入口。
// 这里只做**再导出**，让既有的 `import { ConfigReadError } from './agent-provisioner'`
// 不必全部改写；新代码请直接从 `./openclaw-config` 导入。
export { ConfigReadError } from './openclaw-config';

const DEFAULT_USER_MD = `# User Profile

- 语言偏好：中文
- 称呼方式：随意
`;

const DEFAULT_AGENTS_MD = `# Agent Instructions

- 遵循 SOUL.md 中定义的人格设定
- 使用 memory/ 目录记录重要信息
- 保持角色一致性
`;

const CLAWOPT_IMAGE_GENERATION_CONFIG_KEY = '__clawopt_image_generation_model_config';
const IMAGE_GENERATION_BRIDGE_MODEL_NAME_SUFFIX = ' (Image Generation Bridge)';
const IMAGE_GENERATION_BRIDGE_PROVIDER_IDS = ['openai', 'litellm'] as const;
const NATIVE_IMAGE_GENERATION_PROVIDER_IDS = new Set([
  'comfy',
  'fal',
  'google',
  'litellm',
  'minimax',
  'minimax-portal',
  'openai',
  'openai-codex',
  'openrouter',
  'vydra',
  'xai',
]);
const AGENT_SYSTEM_PROMPT_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const;

export interface ProvisionOptions {
  agentId: string;
  workspaceDir?: string;
  soulContent?: string;
  userContent?: string;
  agentsContent?: string;
  toolsContent?: string;
  heartbeatContent?: string;
  identityContent?: string;
  model?: string;  // e.g. "openai/gpt-5.2" or "ark/glm-4.7"
  fallbackMode?: AgentFallbackMode;
  fallbacks?: string[];
  systemPromptMode?: AgentSystemPromptMode;
  toolMode?: AgentToolMode;
}

export type AgentFallbackMode = 'inherit' | 'custom' | 'disabled';

export interface AgentModelConfigSnapshot {
  model: string | null;
  modelOverride: string | null;
  fallbackMode: AgentFallbackMode;
  fallbacks: string[];
  resolvedModel: string | null;
}

export interface AgentRuntimeConfigSnapshot {
  systemPromptMode: AgentSystemPromptMode;
  toolMode: AgentToolMode;
}

export interface AgentRuntimeMetricsSnapshot {
  systemPrompt: {
    systemChars: number | null;
    agentChars: number;
    source: 'latest-run' | 'agent-files';
  };
  tools: {
    charsByMode: Record<AgentToolMode, number | null>;
    source: 'latest-run' | 'none';
  };
}

export interface GlobalModelConfigSnapshot {
  primary: string | null;
  fallbacks: string[];
}

export interface ImageGenerationModelConfigSnapshot {
  primary: string | null;
  fallbacks: string[];
}

export interface ImageGenerationEndpointModelSnapshot {
  id: string;
  endpointId: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  authHeader?: string;
  headers?: Record<string, string>;
}

interface ModelRefParts {
  endpointId: string;
  modelName: string;
}

interface ImageGenerationRuntimeConfig {
  primary: string | null;
  fallbacks: string[];
}

export class AgentProvisioner {
  private openclawDir: string;

  constructor() {
    this.openclawDir = path.join(os.homedir(), '.openclaw');
    this.repairKnownModelCapabilities();
  }

  /**
   * 读 `openclaw.json`。判据全在 `openclaw-config.ts`——**这里不再有第二套实现**。
   *
   * 保留这个私有方法而不是让每个调用点直接调网关，是因为本类里有二十多处调用，
   * 逐个替换会让 diff 淹没掉真正的改动；而它现在只是一行转发，不构成第二条判据。
   */
  private readConfigFile(): any | null {
    return readOpenClawConfigSafe();
  }


  private writeConfigFile(config: any): void {
    const configPath = path.join(this.openclawDir, 'openclaw.json');
    writeJsonAtomicSync(configPath, config);
  }

  private readUiModelsFile(): Record<string, any> {
    const uiModelsPath = path.join(this.openclawDir, 'clawopt-models.json');

    // 走网关而不是自己 readFileSync：这个文件曾经是**挂死整个后端**的入口。
    // 把它换成命名管道，一次 `GET /api/models` 就让所有路由永久挂起，
    // 无日志、需要 kill -9——上一轮只给 openclaw.json 加了闸门，
    // 这一个漏在外面。判据只该有一处实现（`AGENTS.md`：堵一个不堵其余等于没堵）。
    try {
      const result = readJsonConfigSafe(uiModelsPath);
      // 这是一份 UI 侧的覆盖文件，不是主配置：形状不对时退回空覆盖是合理降级。
      // 但**要出声**——静默退回会让「文件坏了」和「本来就没配」长得一模一样。
      if (!result.exists) return {};
      const parsed = result.value;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[AgentProvisioner] clawopt-models.json 不是对象，本次忽略该覆盖文件');
        return {};
      }
      return parsed as Record<string, any>;
    } catch (error) {
      // 只记 reason，不记原始 message——它可能带路径或文件原文。
      const reason = error instanceof ConfigReadError ? error.reason : 'unknown';
      const detail = error instanceof ConfigReadError ? error.detail : sanitizeErrorDetail(error);
      console.error(`[AgentProvisioner] clawopt-models.json 读取失败（${reason}：${detail}），本次忽略该覆盖文件`);
      return {};
    }
  }

  private writeUiModelsFile(uiModels: Record<string, any>): void {
    const uiModelsPath = path.join(this.openclawDir, 'clawopt-models.json');
    writeJsonAtomicSync(uiModelsPath, uiModels);
  }

  private readUiImageGenerationModelConfigFrom(uiModels: Record<string, any>): ImageGenerationModelConfigSnapshot | null {
    const raw = uiModels[CLAWOPT_IMAGE_GENERATION_CONFIG_KEY];
    if (!raw || typeof raw !== 'object') return null;

    const primary = this.normalizeModelId(raw.primary);
    const fallbacks = primary ? this.normalizeFallbackIds(raw.fallbacks) : [];
    if (!primary && fallbacks.length === 0) return null;

    return { primary, fallbacks };
  }

  private readUiImageGenerationModelConfig(): ImageGenerationModelConfigSnapshot | null {
    return this.readUiImageGenerationModelConfigFrom(this.readUiModelsFile());
  }

  private writeUiImageGenerationModelConfig(primary: string | null, fallbacks: string[]): boolean {
    const uiModels = this.readUiModelsFile();
    const previous = JSON.stringify(this.readUiImageGenerationModelConfigFrom(uiModels));

    if (!primary) {
      delete uiModels[CLAWOPT_IMAGE_GENERATION_CONFIG_KEY];
    } else {
      uiModels[CLAWOPT_IMAGE_GENERATION_CONFIG_KEY] = {
        primary,
        fallbacks: this.normalizeFallbackIds(fallbacks),
      };
    }

    const next = JSON.stringify(this.readUiImageGenerationModelConfigFrom(uiModels));
    if (previous === next) {
      return false;
    }

    this.writeUiModelsFile(uiModels);
    return true;
  }

  private normalizeInputCapability(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const normalized = trimmed.toLowerCase().replace(/[-\s]+/g, '_');
    if (normalized === 'image_generation' || normalized === 'image_generate' || normalized === 'image_output') {
      return 'image_generation';
    }

    return trimmed;
  }

  private normalizeInputCapabilities(input: unknown): string[] {
    if (!Array.isArray(input)) return [];

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const item of input) {
      const capability = this.normalizeInputCapability(item);
      if (!capability || seen.has(capability)) continue;
      seen.add(capability);
      normalized.push(capability);
    }
    return normalized;
  }

  private inferKnownModelInputCapabilities(modelId: string): string[] {
    const fullModelId = modelId.trim().toLowerCase();
    const slashIdx = modelId.indexOf('/');
    const modelName = (slashIdx === -1 ? modelId : modelId.slice(slashIdx + 1)).trim().toLowerCase();

    if (modelName === 'gpt-5.4') {
      return ['text', 'image'];
    }

    if (
      /(^|[-_.])(gpt[-_.]?image|dall[-_.]?e|imagen|flux|sdxl|stable[-_.]?diffusion|seedream|jimeng|image[-_.]?01|grok[-_.]?imagine)([-_.]|$)/i.test(modelName)
      || /gemini.*image|image[-_.]?preview/i.test(modelName)
      || (/comfy/i.test(fullModelId) && modelName === 'workflow')
    ) {
      return ['image_generation'];
    }

    return [];
  }

  private mergeKnownModelInputCapabilities(modelId: string, input: unknown): string[] {
    const merged = this.normalizeInputCapabilities(input);
    for (const inferred of this.inferKnownModelInputCapabilities(modelId)) {
      if (!merged.includes(inferred)) {
        merged.push(inferred);
      }
    }
    return merged;
  }

  private repairKnownModelCapabilities(): void {
    try {
      const config = this.readConfigFile();
      if (!config) return;

      const configuredIds = Object.keys(config?.agents?.defaults?.models || {});
      if (configuredIds.length === 0) return;

      const uiModels = this.readUiModelsFile();
      let changed = false;

      for (const modelId of configuredIds) {
        const currentInput = uiModels?.[modelId]?.input;
        const repairedInput = this.mergeKnownModelInputCapabilities(modelId, currentInput);
        const normalizedCurrentInput = this.normalizeInputCapabilities(currentInput);
        if (JSON.stringify(repairedInput) === JSON.stringify(normalizedCurrentInput)) {
          continue;
        }

        if (!uiModels[modelId] || typeof uiModels[modelId] !== 'object') {
          uiModels[modelId] = {};
        }
        uiModels[modelId].input = repairedInput;
        changed = true;
      }

      if (changed) {
        this.writeUiModelsFile(uiModels);
      }
    } catch (error) {
      console.error('Failed to repair inferred model capabilities:', error);
    }
  }

  private normalizeModelId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeFallbackIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      normalized.push(trimmed);
    }
    return normalized;
  }

  normalizeSystemPromptMode(value: unknown): AgentSystemPromptMode {
    return value === 'agent' ? 'agent' : 'system';
  }

  normalizeToolMode(value: unknown): AgentToolMode {
    if (value === 'coding' || value === 'messaging' || value === 'minimal' || value === 'off') {
      return value;
    }
    return 'full';
  }

  private getConfiguredModelIds(config: any): Set<string> {
    return new Set(
      Object.keys(config?.agents?.defaults?.models || {}).filter((id) => typeof id === 'string' && id.trim())
    );
  }

  private validateModelIds(config: any, ids: string[]): void {
    const configuredIds = this.getConfiguredModelIds(config);
    if (configuredIds.size === 0) return;

    const missing = ids.filter((id) => !configuredIds.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown model id: ${missing.join(', ')}`);
    }
  }

  private modelSupportsImageGeneration(config: any, modelId: string): boolean {
    const availableModel = this.readAvailableModels().find((model) => model.id === modelId);
    if (availableModel?.input?.includes('image_generation')) {
      return true;
    }

    const directInput = this.mergeKnownModelInputCapabilities(
      modelId,
      config?.agents?.defaults?.models?.[modelId]?.input,
    );
    return directInput.includes('image_generation');
  }

  private validateImageGenerationModelIds(config: any, ids: string[]): void {
    this.validateModelIds(config, ids);
    const unsupported = ids.filter((id) => !this.modelSupportsImageGeneration(config, id));
    if (unsupported.length > 0) {
      throw new Error(`Model does not support image generation: ${unsupported.join(', ')}`);
    }
  }

  private splitModelRef(modelId: string): ModelRefParts | null {
    const trimmed = modelId.trim();
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
      return null;
    }

    return {
      endpointId: trimmed.slice(0, slashIndex).trim(),
      modelName: trimmed.slice(slashIndex + 1).trim(),
    };
  }

  private isNativeImageGenerationProvider(endpointId: string): boolean {
    return NATIVE_IMAGE_GENERATION_PROVIDER_IDS.has(endpointId.trim().toLowerCase());
  }

  private isImageGenerationBridgeProviderId(providerId: string): boolean {
    return (IMAGE_GENERATION_BRIDGE_PROVIDER_IDS as readonly string[]).includes(providerId.trim().toLowerCase());
  }

  private isManagedImageGenerationBridgeProvider(providerId: string, providerConfig: any): boolean {
    if (!this.isImageGenerationBridgeProviderId(providerId)) return false;
    if (!providerConfig || typeof providerConfig !== 'object') return false;
    const models = providerConfig.models;
    return Array.isArray(models)
      && models.length > 0
      && models.every((model: any) => typeof model?.name === 'string' && model.name.endsWith(IMAGE_GENERATION_BRIDGE_MODEL_NAME_SUFFIX));
  }

  private pruneUnusedImageGenerationBridgeProviders(config: any, keepProviderIds: Set<string>): boolean {
    const providers = config?.models?.providers;
    if (!providers || typeof providers !== 'object') return false;

    let changed = false;
    for (const providerId of IMAGE_GENERATION_BRIDGE_PROVIDER_IDS) {
      if (keepProviderIds.has(providerId)) continue;
      if (!this.isManagedImageGenerationBridgeProvider(providerId, providers[providerId])) continue;
      delete providers[providerId];
      changed = true;
    }
    return changed;
  }

  private getImageGenerationBridgeModelName(modelName: string): string {
    return modelName.trim();
  }

  private getEndpointProviderConfig(config: any, endpointId: string): any | null {
    const providers = config?.models?.providers;
    if (!providers || typeof providers !== 'object') return null;
    const direct = providers[endpointId];
    if (direct && typeof direct === 'object') return direct;

    const normalized = endpointId.trim().toLowerCase();
    const matched = Object.entries(providers).find(([id]) => id.trim().toLowerCase() === normalized);
    const providerConfig = matched?.[1];
    return providerConfig && typeof providerConfig === 'object' ? providerConfig : null;
  }

  private configureImageGenerationBridgeProvider(
    config: any,
    bridgeProviderId: string,
    endpointId: string,
    modelNames: string[],
  ): boolean {
    const sourceProvider = this.getEndpointProviderConfig(config, endpointId);
    if (!sourceProvider) {
      throw new Error(`Image generation endpoint not found: ${endpointId}`);
    }

    const baseUrl = typeof sourceProvider.baseUrl === 'string' ? sourceProvider.baseUrl.trim() : '';
    if (!baseUrl) {
      throw new Error(`Image generation endpoint "${endpointId}" is missing baseUrl`);
    }

    if (sourceProvider.apiKey === undefined || sourceProvider.apiKey === null || String(sourceProvider.apiKey).trim() === '') {
      throw new Error(`Image generation endpoint "${endpointId}" is missing apiKey`);
    }

    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    const uniqueModelNames = Array.from(new Set(modelNames.map((name) => name.trim()).filter(Boolean)));
    const nextProvider: Record<string, any> = {
      api: 'openai-completions',
      auth: 'api-key',
      baseUrl,
      apiKey: sourceProvider.apiKey,
      models: uniqueModelNames.map((id) => ({
        id,
        name: `${id}${IMAGE_GENERATION_BRIDGE_MODEL_NAME_SUFFIX}`,
        api: 'openai-completions',
        reasoning: false,
        input: ['text'],
      })),
    };

    if (sourceProvider.request !== undefined) {
      nextProvider.request = sourceProvider.request;
    }
    if (sourceProvider.headers !== undefined) {
      nextProvider.headers = sourceProvider.headers;
    }
    if (sourceProvider.authHeader !== undefined) {
      nextProvider.authHeader = sourceProvider.authHeader;
    }

    const previousSerialized = JSON.stringify(config.models.providers[bridgeProviderId] || null);
    config.models.providers[bridgeProviderId] = nextProvider;
    return previousSerialized !== JSON.stringify(nextProvider);
  }

  private buildImageGenerationRuntimeConfig(
    config: any,
    primary: string | null,
    fallbacks: string[],
  ): { runtime: ImageGenerationRuntimeConfig; bridgeChanged: boolean } {
    if (!primary) {
      return {
        runtime: { primary: null, fallbacks: [] },
        bridgeChanged: false,
      };
    }

    const refs = [primary, ...fallbacks]
      .map((id) => ({ id, parts: this.splitModelRef(id) }))
      .filter((entry): entry is { id: string; parts: ModelRefParts } => entry.parts !== null);

    const bridgeProviderByEndpoint = new Map<string, string>();
    const bridgeModelNamesByProvider = new Map<string, string[]>();

    const resolveBridgeProviderId = (endpointId: string): string | null => {
      const existing = bridgeProviderByEndpoint.get(endpointId);
      if (existing) return existing;

      const bridgeProviderId = IMAGE_GENERATION_BRIDGE_PROVIDER_IDS[bridgeProviderByEndpoint.size];
      if (!bridgeProviderId) return null;

      bridgeProviderByEndpoint.set(endpointId, bridgeProviderId);
      bridgeModelNamesByProvider.set(bridgeProviderId, []);
      return bridgeProviderId;
    };

    const toRuntimeRef = (id: string): string | null => {
      const parts = this.splitModelRef(id);
      if (!parts) return id;
      if (this.isNativeImageGenerationProvider(parts.endpointId)) return id;
      const bridgeProviderId = resolveBridgeProviderId(parts.endpointId);
      if (!bridgeProviderId) return null;

      const bridgeModelName = this.getImageGenerationBridgeModelName(parts.modelName);
      if (bridgeModelName) {
        bridgeModelNamesByProvider.get(bridgeProviderId)?.push(bridgeModelName);
        return `${bridgeProviderId}/${bridgeModelName}`;
      }

      return null;
    };

    const runtimePrimary = toRuntimeRef(primary);
    const runtimeFallbacks = this.normalizeFallbackIds(
      fallbacks
        .map((id) => toRuntimeRef(id))
        .filter((id): id is string => Boolean(id && id !== runtimePrimary)),
    );

    let bridgeChanged = false;
    for (const [endpointId, bridgeProviderId] of bridgeProviderByEndpoint) {
      bridgeChanged = this.configureImageGenerationBridgeProvider(
        config,
        bridgeProviderId,
        endpointId,
        bridgeModelNamesByProvider.get(bridgeProviderId) || [],
      ) || bridgeChanged;
    }
    bridgeChanged = this.pruneUnusedImageGenerationBridgeProviders(
      config,
      new Set(bridgeProviderByEndpoint.values()),
    ) || bridgeChanged;

    return {
      runtime: {
        primary: runtimePrimary || null,
        fallbacks: runtimeFallbacks,
      },
      bridgeChanged,
    };
  }

  private readStoredModelValue(raw: any): { primary: string | null; hasFallbacks: boolean; fallbacks: string[] } {
    if (typeof raw === 'string') {
      return {
        primary: this.normalizeModelId(raw),
        hasFallbacks: false,
        fallbacks: [],
      };
    }

    if (!raw || typeof raw !== 'object') {
      return {
        primary: null,
        hasFallbacks: false,
        fallbacks: [],
      };
    }

    return {
      primary: this.normalizeModelId(raw.primary),
      hasFallbacks: Object.prototype.hasOwnProperty.call(raw, 'fallbacks'),
      fallbacks: this.normalizeFallbackIds(raw.fallbacks),
    };
  }

  private resolveFallbackMode(hasFallbacks: boolean, fallbacks: string[]): AgentFallbackMode {
    if (!hasFallbacks) return 'inherit';
    return fallbacks.length > 0 ? 'custom' : 'disabled';
  }

  private buildStoredModelValue(
    primary: string | null,
    fallbackMode: AgentFallbackMode,
    fallbacks: string[]
  ): any {
    const normalizedPrimary = this.normalizeModelId(primary);
    const normalizedFallbacks = this.normalizeFallbackIds(fallbacks);

    if (fallbackMode === 'inherit') {
      return normalizedPrimary || undefined;
    }

    const next: Record<string, any> = {
      fallbacks: fallbackMode === 'disabled' ? [] : normalizedFallbacks,
    };

    if (normalizedPrimary) {
      next.primary = normalizedPrimary;
    }

    return next;
  }

  private ensureAgentEntry(config: any, agentId: string, workspaceDir: string) {
    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];

    let entry = config.agents.list.find((item: any) => item.id === agentId);
    if (!entry) {
      entry = { id: agentId, workspace: workspaceDir };
      config.agents.list.push(entry);
      return { entry, created: true, workspaceChanged: false };
    }

    let workspaceChanged = false;
    if (entry.workspace !== workspaceDir) {
      entry.workspace = workspaceDir;
      workspaceChanged = true;
    }

    return { entry, created: false, workspaceChanged };
  }

  private findAgentEntry(config: any, agentId: string): any | null {
    if (!Array.isArray(config?.agents?.list)) return null;
    return config.agents.list.find((item: any) => item?.id === agentId) || null;
  }

  private readLatestSystemPromptReport(agentId: string): any | null {
    const sessionsPath = path.join(this.openclawDir, 'agents', agentId, 'sessions', 'sessions.json');
    if (!fs.existsSync(sessionsPath)) return null;

    try {
      // 走网关：这个文件同样可能是命名管道，同步读会永久挂死。
      // 「只有主配置需要闸门」是上一轮的错误假设——判据是「同步读一个我们不控制的
      // 文件路径」，凡是满足这个判据的都要过闸门。
      const result = readJsonConfigSafe(sessionsPath);
      if (!result.exists) return null;
      const parsed = result.value as any;
      const entries = (Array.isArray(parsed) ? parsed : Object.values(parsed || {}))
        .filter((entry: any) => entry?.systemPromptReport && typeof entry.systemPromptReport === 'object');

      entries.sort((left: any, right: any) => {
        const leftTs = Number(left?.systemPromptReport?.generatedAt || left?.updatedAt || left?.updated_at || 0);
        const rightTs = Number(right?.systemPromptReport?.generatedAt || right?.updatedAt || right?.updated_at || 0);
        return leftTs - rightTs;
      });

      return entries.at(-1)?.systemPromptReport || null;
    } catch (error) {
      console.error(`[AgentProvisioner] Failed to read latest system prompt report for ${agentId}:`, error);
      return null;
    }
  }

  readAgentRuntimeMetrics(agentId: string, toolsCatalogResult?: any): AgentRuntimeMetricsSnapshot {
    const report = this.readLatestSystemPromptReport(agentId);
    const reportToolEntries = Array.isArray(report?.tools?.entries) ? report.tools.entries : [];
    const toolEntryByName = new Map<string, { schemaChars?: number }>();
    for (const entry of reportToolEntries) {
      if (typeof entry?.name !== 'string') continue;
      toolEntryByName.set(entry.name, {
        schemaChars: typeof entry.schemaChars === 'number' ? entry.schemaChars : undefined,
      });
    }

    const sumToolSchemaChars = (toolNames: string[]): number | null => {
      let total = 0;
      let matched = 0;
      for (const toolName of toolNames) {
        const chars = toolEntryByName.get(toolName)?.schemaChars;
        if (typeof chars !== 'number') continue;
        total += chars;
        matched += 1;
      }
      return matched > 0 ? total : null;
    };

    const catalogTools = Array.isArray(toolsCatalogResult?.groups)
      ? toolsCatalogResult.groups.flatMap((group: any) => Array.isArray(group?.tools) ? group.tools : [])
      : [];
    const toolNamesForProfile = (profile: Exclude<AgentToolMode, 'off'>): string[] => (
      catalogTools
        .filter((tool: any) => Array.isArray(tool?.defaultProfiles) && tool.defaultProfiles.includes(profile))
        .map((tool: any) => typeof tool?.id === 'string' ? tool.id : '')
        .filter(Boolean)
    );

    const fullSchemaChars = typeof report?.tools?.schemaChars === 'number'
      ? report.tools.schemaChars
      : (reportToolEntries.length > 0
        ? reportToolEntries.reduce((sum: number, entry: any) => sum + (typeof entry?.schemaChars === 'number' ? entry.schemaChars : 0), 0)
        : null);

    const charsByMode: Record<AgentToolMode, number | null> = {
      full: fullSchemaChars,
      coding: null,
      messaging: null,
      minimal: null,
      off: 0,
    };

    for (const profile of ['coding', 'messaging', 'minimal'] as const) {
      const catalogToolNames = toolNamesForProfile(profile);
      charsByMode[profile] = catalogToolNames.length > 0
        ? sumToolSchemaChars(catalogToolNames)
        : (profile === 'minimal' ? sumToolSchemaChars(['session_status']) : null);
    }

    return {
      systemPrompt: {
        systemChars: typeof report?.systemPrompt?.chars === 'number' ? report.systemPrompt.chars : null,
        agentChars: this.buildAgentSystemPromptOverride(agentId).length,
        source: report ? 'latest-run' : 'agent-files',
      },
      tools: {
        charsByMode,
        source: report ? 'latest-run' : 'none',
      },
    };
  }

  buildAgentSystemPromptOverride(agentId: string): string {
    const workspaceDir = this.getWorkspacePath(agentId);
    const sections: string[] = [];

    for (const filename of AGENT_SYSTEM_PROMPT_FILES) {
      const filePath = path.join(workspaceDir, filename);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      if (!content) continue;
      sections.push(`## ${filename}\n\n${content}`);
    }

    if (sections.length === 0) {
      return `# Agent ${agentId}\n\nFollow this agent's workspace instructions.`;
    }

    return [
      `# Agent ${agentId}`,
      'Follow this agent-specific prompt. The sections below come from this agent workspace.',
      ...sections,
    ].join('\n\n');
  }

  readAgentRuntimeConfig(agentId: string): AgentRuntimeConfigSnapshot {
    const config = this.readConfigFile();
    const entry = config ? this.findAgentEntry(config, agentId) : null;
    const tools = entry?.tools && typeof entry.tools === 'object' ? entry.tools : null;
    const profile = typeof tools?.profile === 'string' ? tools.profile : null;
    const deny = Array.isArray(tools?.deny) ? tools.deny : [];
    const hasDenyAll = deny.some((item: unknown) => typeof item === 'string' && item.trim() === '*');

    return {
      systemPromptMode: typeof entry?.systemPromptOverride === 'string' && entry.systemPromptOverride.trim()
        ? 'agent'
        : 'system',
      toolMode: hasDenyAll
        ? 'off'
        : (profile === 'coding' || profile === 'messaging' || profile === 'minimal' ? profile : 'full'),
    };
  }

  updateAgentRuntimeConfig(
    agentId: string,
    runtimeConfig: {
      systemPromptMode?: AgentSystemPromptMode;
      toolMode?: AgentToolMode;
      workspaceDir?: string;
    },
  ): boolean {
    const config = this.readConfigFile();
    if (!config) return false;

    const workspaceDir = runtimeConfig.workspaceDir || this.getWorkspacePath(agentId);
    const { entry, created, workspaceChanged } = this.ensureAgentEntry(config, agentId, workspaceDir);
    const previousSerialized = JSON.stringify(entry);

    const systemPromptMode = this.normalizeSystemPromptMode(runtimeConfig.systemPromptMode);
    if (systemPromptMode === 'agent') {
      entry.systemPromptOverride = this.buildAgentSystemPromptOverride(agentId);
    } else {
      delete entry.systemPromptOverride;
    }

    const toolMode = this.normalizeToolMode(runtimeConfig.toolMode);
    if (toolMode === 'off') {
      entry.tools = { deny: ['*'] };
    } else {
      entry.tools = { profile: toolMode };
    }

    const changed = created || workspaceChanged || previousSerialized !== JSON.stringify(entry);
    if (!changed) return false;

    this.writeConfigFile(config);
    return true;
  }

  private assignModelValue(entry: any, nextValue: any): boolean {
    const prevSerialized = Object.prototype.hasOwnProperty.call(entry, 'model')
      ? JSON.stringify(entry.model)
      : '__missing__';

    if (nextValue === undefined) {
      if (!Object.prototype.hasOwnProperty.call(entry, 'model')) {
        return false;
      }
      delete entry.model;
      return true;
    }

    const nextSerialized = JSON.stringify(nextValue);
    if (prevSerialized === nextSerialized) {
      return false;
    }

    entry.model = nextValue;
    return true;
  }

  private pruneModelValue(raw: any, deletedIds: Set<string>): any {
    const stored = this.readStoredModelValue(raw);
    const nextPrimary = stored.primary && deletedIds.has(stored.primary) ? null : stored.primary;
    const nextFallbacks = stored.fallbacks.filter((id) => !deletedIds.has(id));

    if (!stored.hasFallbacks) {
      return nextPrimary || undefined;
    }

    return this.buildStoredModelValue(
      nextPrimary,
      nextFallbacks.length > 0 ? 'custom' : 'disabled',
      nextFallbacks
    );
  }

  private pruneImageGenerationModel(config: any, deletedIds: Set<string>): void {
    if (!config?.agents?.defaults || !Object.prototype.hasOwnProperty.call(config.agents.defaults, 'imageGenerationModel')) {
      return;
    }

    const current = this.readStoredModelValue(config.agents.defaults.imageGenerationModel);
    let nextPrimary = current.primary && deletedIds.has(current.primary) ? null : current.primary;
    let nextFallbacks = current.fallbacks.filter((id) => !deletedIds.has(id));

    if (!nextPrimary && nextFallbacks.length > 0) {
      nextPrimary = nextFallbacks[0];
      nextFallbacks = nextFallbacks.slice(1);
    }

    if (!nextPrimary && nextFallbacks.length === 0) {
      delete config.agents.defaults.imageGenerationModel;
      return;
    }

    config.agents.defaults.imageGenerationModel = this.buildStoredModelValue(
      nextPrimary,
      current.hasFallbacks || nextFallbacks.length > 0 ? (nextFallbacks.length > 0 ? 'custom' : 'disabled') : 'inherit',
      nextFallbacks,
    );
  }

  /**
   * Slugify a name to be used as a directory and agent ID
   */
  slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '_')
      .replace(/^-+|-+$/g, '');
    
    // Fallback if slug is empty (e.g. only Chinese characters)
    return slug || `agent_${Date.now().toString(36)}`;
  }

  /**
   * Get the workspace path for a given agentId.
   * Rule: agent "abc" uses "workspace-abc". No special cases.
   */
  getWorkspacePath(agentId: string): string {
    return path.join(this.openclawDir, `workspace-${agentId}`);
  }

  /**
   * Ensure the 'main' agent has its workspace path registered in openclaw.json.
   * Called at application startup so that the OpenClaw engine also picks up
   * the correct workspace-main/ path instead of the default workspace/.
   */
  ensureMainAgent(): boolean {
    const configPath = path.join(this.openclawDir, 'openclaw.json');

    // 复用 readConfigFile()：这是启动期唯一还在自己 JSON.parse 的调用点，
    // 配置损坏时会把 SyntaxError 未捕获地扔到 server.listen() 之前，整个
    // 后端进程死在启动线上——比运行期任何一个「读不动」都更糟，因为端口
    // 从未监听，连这条请求都发不出去。ConfigReadError 在这里被当成
    // 「这一步跳过，进程继续活」，不是「没有 main agent」：真正的运行期
    // 接口（/api/characters 等）会在服务起来之后用同一个 ConfigReadError
    // 报告出结构化的失败原因，用户不会看到假的成功，只会晚一拍看到真相。
    let config: any;
    try {
      config = this.readConfigFile();
    } catch (error) {
      if (error instanceof ConfigReadError) {
        console.error(
          `[AgentProvisioner] ensureMainAgent 跳过（openclaw.json 读不动，reason=${error.reason}）：${error.detail}`,
        );
        return false;
      }
      throw error;
    }
    if (!config) return false; // 文件不存在：全新安装，合法状态

    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];

    const workspaceDir = this.getWorkspacePath('main');
    const existing = config.agents.list.find((a: any) => a.id === 'main');

    if (existing) {
      if (existing.workspace === workspaceDir) return false; // already correct
      existing.workspace = workspaceDir;
    } else {
      config.agents.list.push({ id: 'main', workspace: workspaceDir });
    }

    // Ensure the workspace directory exists
    fs.mkdirSync(workspaceDir, { recursive: true });

    writeJsonAtomicSync(configPath, config);
    console.log(`[AgentProvisioner] Registered main agent workspace: ${workspaceDir}`);
    return true;
  }

  /**
   * Provision a fully isolated agent environment in OpenClaw.
   * 
   * Creates:
   * - Independent workspace with SOUL.md, USER.md, AGENTS.md, memory/
   * - Agent entry in openclaw.json agents.list[]
   * - Copies auth-profiles.json from main agent for credential inheritance
   */
  async provision(opts: ProvisionOptions): Promise<boolean> {
    try {
      if (!fs.existsSync(this.openclawDir)) {
        // 抛而不是 return false：调用方从来不看这个返回值，于是「OpenClaw 根本没装」
        // 也会被报成装配成功，界面全绿而 Agent 是空壳。
        throw new Error(`OpenClaw directory not found at ${this.openclawDir}`);
      }


      let createdWorkspaceArtifacts = false;
      let copiedAuthProfile = false;
      const workspaceDir = opts.workspaceDir || this.getWorkspacePath(opts.agentId);
      const agentDir = path.join(this.openclawDir, 'agents', opts.agentId, 'agent');
      const memoryDir = path.join(workspaceDir, 'memory');
      
      // 1. Create workspace directory structure
      const ensureDir = (dirPath: string) => {
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
          createdWorkspaceArtifacts = true;
        }
      };

      ensureDir(workspaceDir);
      ensureDir(memoryDir);
      ensureDir(agentDir);

      // 2. Write workspace files
      const writeFileSafe = (filename: string, content: string | undefined, defaultContent?: string) => {
        const filePath = path.join(workspaceDir, filename);
        if (content !== undefined) {
          if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8') !== content) {
            fs.writeFileSync(filePath, content);
            createdWorkspaceArtifacts = true;
          }
        } else if (defaultContent !== undefined && !fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, defaultContent);
          createdWorkspaceArtifacts = true;
        }
      };

      writeFileSafe('SOUL.md', opts.soulContent, '# Agent\nDefault identity.');
      writeFileSafe('USER.md', opts.userContent, '# User Profile\n\n- 语言偏好：中文\n- 称呼方式：随意\n');
      writeFileSafe('AGENTS.md', opts.agentsContent, '# Agent Instructions\n\n- 遵循 SOUL.md 中定义的人格设定\n- 使用 memory/ 目录记录重要信息\n- 保持角色一致性\n');
      writeFileSafe('TOOLS.md', opts.toolsContent);
      writeFileSafe('HEARTBEAT.md', opts.heartbeatContent);
      writeFileSafe('IDENTITY.md', opts.identityContent);

      // 3. Copy auth-profiles.json from main agent for credential inheritance
      const mainAuthPath = path.join(this.openclawDir, 'agents', 'main', 'agent', 'auth-profiles.json');
      const agentAuthPath = path.join(agentDir, 'auth-profiles.json');
      if (fs.existsSync(mainAuthPath) && !fs.existsSync(agentAuthPath)) {
        // 先过闸门再复制。`copyFileSync` 不叫 read，但它一样会在命名管道上
        // **永久阻塞**——第五轮对抗测试实证：把 auth-profiles.json 换成管道，
        // 建一个 Agent 就让整个后端挂死（栈：node::fs::CopyFile → uv_fs_copyfile）。
        // 判据是「同步操作一个不受控的路径」，与「是不是在读」无关。
        assertRegularFile(mainAuthPath);
        fs.copyFileSync(mainAuthPath, agentAuthPath);
        copiedAuthProfile = true;
      }

      // 4. Update openclaw.json agents.list[]
      const configChanged = this.updateConfigList(
        opts.agentId,
        workspaceDir,
        opts.model,
        opts.fallbackMode,
        opts.fallbacks,
        opts.systemPromptMode,
        opts.toolMode,
      );

      if (configChanged || createdWorkspaceArtifacts || copiedAuthProfile) {
        console.log(`[AgentProvisioner] Provisioned agent "${opts.agentId}" at ${workspaceDir}`);
      }
      return configChanged;
    } catch (error) {
      console.error('Failed to provision agent:', error);
      // 同上：失败必须让调用方知道。装配是「一键复制」的主链路，
      // 它静默成功比直接报错危险得多——用户以为装好了，实际什么都没有。
      throw error;
    }
  }

  /**
   * Remove an agent from openclaw.json agents.list[]
   * Also removes the workspace directory and agent state directory.
   */
  async deprovision(agentId: string): Promise<boolean> {
    try {
      if (agentId === 'main') return false;

      const configPath = path.join(this.openclawDir, 'openclaw.json');
      if (!fs.existsSync(configPath)) return false;

      // 走 readConfigFile()，不再自己 JSON.parse。
      //
      // 原来这里是一条独立的裸解析 + 外层 `catch → return false`，于是
      // `DELETE /api/sessions/:id` 在配置损坏时**返回 200 success**，
      // 而配置条目、工作区、agent 状态目录、记忆库全都还在（对抗测试实证）。
      // 「删干净了」和「一个字节没删」在界面上长得一模一样——这正是本 sprint
      // 要修的那类失败，只是当时只审计了 provision() 这一侧。
      const config = this.readConfigFile();
      if (!config) return false;

      let configChanged = false;
      if (config.agents?.list && Array.isArray(config.agents.list)) {
        const before = config.agents.list.length;
        config.agents.list = config.agents.list.filter(
          (a: any) => a.id !== agentId
        );
        if (config.agents.list.length < before) {
          configChanged = true;
          // If list is empty, remove it entirely to keep config clean
          if (config.agents.list.length === 0) {
            delete config.agents.list;
          }
          writeJsonAtomicSync(configPath, config);
        }
      }

      // Clean up workspace directory
      const workspaceDir = this.getWorkspacePath(agentId);
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        console.log(`[AgentProvisioner] Removed workspace ${workspaceDir}`);
      }

      // Clean up agent state directory
      const agentStateDir = path.join(this.openclawDir, 'agents', agentId);
      if (fs.existsSync(agentStateDir)) {
        fs.rmSync(agentStateDir, { recursive: true, force: true });
        console.log(`[AgentProvisioner] Removed agent state ${agentStateDir}`);
      }

      const memoryDbPath = path.join(this.openclawDir, 'memory', `${agentId}.sqlite`);
      if (fs.existsSync(memoryDbPath)) {
        fs.rmSync(memoryDbPath, { force: true });
        console.log(`[AgentProvisioner] Removed agent memory ${memoryDbPath}`);
      }

      console.log(`[AgentProvisioner] Deprovisioned agent "${agentId}"`);
      return configChanged;
    } catch (error) {
      // ConfigReadError 往上抛：`return false` 会让 DELETE 路由报成功，
      // 而配置条目、工作区、状态目录、记忆库一个都没删。
      // 「删干净了」与「一个字节没删」在界面上长得一模一样，正是红线 C 禁止的形状。
      if (error instanceof ConfigReadError) throw error;
      console.error('Failed to deprovision agent:', error);
      return false;
    }
  }

  /**
   * Remove an agent entry from openclaw.json without touching its workspace.
   * Useful when the workspace is managed outside the default workspace-{agentId} rule.
   */
  removeConfigEntry(agentId: string): boolean {
    if (agentId === 'main') return false;

    const configPath = path.join(this.openclawDir, 'openclaw.json');
    if (!fs.existsSync(configPath)) return false;

    // 这一处是上一轮 grep 漏掉的第二条裸读路径。收进网关。
    const config = this.readConfigFile();
    if (!config) return false;

    if (!config.agents?.list || !Array.isArray(config.agents.list)) {
      return false;
    }

    const before = config.agents.list.length;
    config.agents.list = config.agents.list.filter((a: any) => a.id !== agentId);
    if (config.agents.list.length === before) {
      return false;
    }

    if (config.agents.list.length === 0) {
      delete config.agents.list;
    }

    writeJsonAtomicSync(configPath, config);
    return true;
  }

  /**
   * Update SOUL.md for an existing agent.
   */
  async updateSoul(agentId: string, soulContent: string): Promise<void> {
    const workspaceDir = this.getWorkspacePath(agentId);
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(soulPath, soulContent || '# Agent\nDefault identity.');
  }

  /**
   * Read SOUL.md content for a given agent.
   */
  readSoul(agentId: string): string | null {
    const workspaceDir = this.getWorkspacePath(agentId);
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (fs.existsSync(soulPath)) {
      return fs.readFileSync(soulPath, 'utf-8');
    }
    return null;
  }

  /**
   * Read available models from openclaw.json agents.defaults.models
   * Returns an array of { id: "provider/modelId", alias?: string, primary: boolean }
   */
  readAvailableModels(): { id: string; alias?: string; primary: boolean; input: string[] }[] {
    try {
      this.repairKnownModelCapabilities();
      const config = this.readConfigFile();
      if (!config) return [];
      const modelsMap = config?.agents?.defaults?.models;
      const primaryModel = this.readGlobalModelConfig().primary;
      if (!modelsMap || typeof modelsMap !== 'object') return [];

      return Object.entries(modelsMap).map(([id, meta]: [string, any]) => {
        // First look for input capabilities stored directly on this model entry
        let input: string[] = Array.isArray(meta?.input) ? meta.input : [];

        // Fallback: check the provider's model list definition in models.providers
        if (!input.length) {
          const slashIdx = id.indexOf('/');
          if (slashIdx !== -1) {
            const endpointId = id.slice(0, slashIdx);
            const modelName = id.slice(slashIdx + 1);
            const providerModels = config?.models?.providers?.[endpointId]?.models;
            if (Array.isArray(providerModels)) {
              const pModel = providerModels.find((m: any) => m.id === modelName);
              if (Array.isArray(pModel?.input)) {
                for (const item of pModel.input) {
                  if (!input.includes(item)) input.push(item);
                }
              }
            }
          }
        }

        // Overlay from clawopt-models.json 
        try {
          // 复用 readUiModelsFile()：它已经过了网关（stat 闸门 + 脱敏）。
          // 这里原来是第三条各自为政的裸读。
          {
            const uiModels = this.readUiModelsFile();
            if (uiModels[id] && Array.isArray(uiModels[id].input)) {
              input = uiModels[id].input;
            }
          }
        } catch(e) {}

        input = this.mergeKnownModelInputCapabilities(id, input);

        return {
          id,
          alias: meta?.alias || undefined,
          primary: id === primaryModel,
          input,
        };
      });
    } catch (err) {
      // ConfigReadError 是「配置读不动」这件事本身，不是「没有模型」——吞成 []
      // 会让调用方以为配置是空的（合法状态），而不是坏的。往上抛，让调用方走
      // 真正的失败路径（各路由已有的 try/catch → 结构化 500）。
      if (err instanceof ConfigReadError) throw err;
      console.error('Failed to read models from openclaw.json:', err);
      return [];
    }
  }

  /**
   * Add a new model to openclaw.json
   */
  async addModelConfig(endpoint: string, modelName: string, alias?: string, input?: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};

    const modelId = `${endpoint}/${modelName}`;
    if (config.agents.defaults.models[modelId]) {
      // Model already exists
      return false;
    }

    const normalizedInput = input !== undefined
      ? this.mergeKnownModelInputCapabilities(modelId, input)
      : undefined;

    const entry: Record<string, any> = {};
    if (alias && alias.trim()) entry.alias = alias.trim();
    config.agents.defaults.models[modelId] = entry;

    // Synchronize capabilities to clawopt-models.json to avoid strict schema validation
    if (normalizedInput && normalizedInput.length > 0) {
      try {
        const uiModels: any = this.readUiModelsFile();
        if (!uiModels[modelId]) uiModels[modelId] = {};
        uiModels[modelId].input = normalizedInput;
        this.writeUiModelsFile(uiModels);
      } catch(e) { console.error('Failed to sync UI models:', e); }
    }

    // Synchronize to models.providers[endpoint].models so OpenClaw engine can route it
    if (config.models?.providers?.[endpoint]) {
      const provider = config.models.providers[endpoint];
      if (!provider.models) provider.models = [];
      
      const existingModel = provider.models.find((m: any) => m.id === modelName);
      if (existingModel) {
        existingModel.name = existingModel.name || `${modelName} (Custom Provider)`;
        if (normalizedInput && normalizedInput.length > 0) existingModel.input = normalizedInput;
      } else {
        provider.models.push({
          id: modelName,
          name: `${modelName} (Custom Provider)`,
          api: provider.api || 'openai-completions',
          reasoning: false,
          input: normalizedInput && normalizedInput.some(i => i === 'text' || i === 'image')
            ? normalizedInput.filter(i => i === 'text' || i === 'image')
            : ['text']
        });
      }
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Delete a model from openclaw.json and fallback agents using it to default
   */
  async deleteModelConfig(modelId: string): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents?.defaults?.models?.[modelId]) {
      return false; // Model doesn't exist
    }

    // 1. Remove the model definition
    delete config.agents.defaults.models[modelId];

    // 2. Handle primary model fallback
    const globalModelConfig = this.readStoredModelValue(config.agents?.defaults?.model);
    if (globalModelConfig.primary === modelId) {
      // Choose the first available model as the new primary, or delete it
      const remainingModels = Object.keys(config.agents.defaults.models);
      if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
      }
      if (remainingModels.length > 0) {
        config.agents.defaults.model.primary = remainingModels[0];
      } else {
        delete config.agents.defaults.model.primary;
      }
    }

    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
      config.agents.defaults.model = {};
    }
    if (globalModelConfig.primary && globalModelConfig.primary !== modelId) {
      config.agents.defaults.model.primary = globalModelConfig.primary;
    }
    config.agents.defaults.model.fallbacks = globalModelConfig.fallbacks.filter((id) => id !== modelId);
    this.pruneImageGenerationModel(config, new Set([modelId]));

    // 3. Fallback agents that were using this model (deleting their 'model' falls back to default)
    if (Array.isArray(config.agents.list)) {
      config.agents.list.forEach((agent: any) => {
        const pruned = this.pruneModelValue(agent.model, new Set([modelId]));
        if (pruned === undefined) delete agent.model;
        else agent.model = pruned;
      });
    }

    // 4. Remove from models.providers if it exists there
    const slashIdx = modelId.indexOf('/');
    if (slashIdx !== -1) {
      const endpoint = modelId.slice(0, slashIdx);
      const modelName = modelId.slice(slashIdx + 1);
      if (config.models?.providers?.[endpoint]?.models) {
        config.models.providers[endpoint].models = config.models.providers[endpoint].models.filter(
          (m: any) => m.id !== modelName
        );
      }
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Set a model as the default (primary) model in openclaw.json
   */
  async setDefaultModel(modelId: string): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    const defaultsModelEntry = this.readStoredModelValue(config.agents.defaults.model);

    // Validate if the model actually exists
    if (!config.agents.defaults.models?.[modelId]) {
      return false;
    }

    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
      config.agents.defaults.model = {};
    }

    config.agents.defaults.model.primary = modelId;

    // Explicitly sync this to the 'main' agent in agents.list so OpenClaw Gateway hot-swaps it
    if (config.agents.list && Array.isArray(config.agents.list)) {
      const mainAgent = config.agents.list.find((a: any) => a.id === 'main');
      if (mainAgent) {
        const mainModel = this.readStoredModelValue(mainAgent.model);
        mainAgent.model = mainModel.hasFallbacks
          ? this.buildStoredModelValue(modelId, this.resolveFallbackMode(mainModel.hasFallbacks, mainModel.fallbacks), mainModel.fallbacks)
          : modelId;
      }
    }

    if (defaultsModelEntry.fallbacks.length > 0) {
      config.agents.defaults.model.fallbacks = defaultsModelEntry.fallbacks;
    } else if (Object.prototype.hasOwnProperty.call(config.agents.defaults.model, 'fallbacks')) {
      config.agents.defaults.model.fallbacks = defaultsModelEntry.fallbacks;
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Update a model's alias in openclaw.json
   */
  async updateModelConfig(modelId: string, alias?: string, input?: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.agents?.defaults?.models?.[modelId]) {
      return false; // Model doesn't exist
    }

    const normalizedInput = input !== undefined
      ? this.mergeKnownModelInputCapabilities(modelId, input)
      : undefined;

    const current = config.agents.defaults.models[modelId] || {};
    const updated: Record<string, any> = { ...current };

    // Update alias
    if (alias !== undefined) {
      if (alias.trim()) updated.alias = alias.trim();
      else delete updated.alias;
    }

    // Update input capabilities (in clawopt-models.json instead of openclaw.json)
    if (normalizedInput !== undefined) {
      try {
        let uiModels: any = this.readUiModelsFile();
        if (!uiModels[modelId]) uiModels[modelId] = {};
        
        if (normalizedInput.length > 0) {
          uiModels[modelId].input = normalizedInput;
        } else {
          delete uiModels[modelId].input;
        }
        this.writeUiModelsFile(uiModels);
      } catch(e) { console.error('Failed to sync updated UI models:', e); }

      if (!normalizedInput.includes('image_generation')) {
        this.pruneImageGenerationModel(config, new Set([modelId]));
      }
    }

    config.agents.defaults.models[modelId] = updated;
    this.writeConfigFile(config);
    return true;
  }

  /**
   * Delete all models under a given endpoint in openclaw.json, and the endpoint itself
   */
  async deleteEndpointConfig(endpoint: string): Promise<number> {
    const config = this.readConfigFile();
    if (!config) return 0;
    let deletedCount = 0;

    // 1. Delete associated models
    if (config.agents?.defaults?.models) {
      const prefix = `${endpoint}/`;
      const toDelete = Object.keys(config.agents.defaults.models).filter(id => id.startsWith(prefix));
      
      for (const modelId of toDelete) {
        delete config.agents.defaults.models[modelId];
        deletedCount++;
      }

      // Handle primary model fallback
      const deletedSet = new Set(toDelete);
      const defaultModelConfig = this.readStoredModelValue(config.agents?.defaults?.model);
      const primary = defaultModelConfig.primary;
      if (primary && toDelete.includes(primary)) {
        const remaining = Object.keys(config.agents.defaults.models);
        if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
          config.agents.defaults.model = {};
        }
        if (remaining.length > 0) {
          config.agents.defaults.model.primary = remaining[0];
        } else {
          delete config.agents.defaults.model.primary;
        }
      }

      if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
      }
      if (primary && !deletedSet.has(primary)) {
        config.agents.defaults.model.primary = primary;
      }
      config.agents.defaults.model.fallbacks = defaultModelConfig.fallbacks
        .filter((id: string) => !deletedSet.has(id));
      this.pruneImageGenerationModel(config, deletedSet);

      // Fallback agents using any deleted model
      if (Array.isArray(config.agents.list)) {
        config.agents.list.forEach((agent: any) => {
          const pruned = this.pruneModelValue(agent.model, deletedSet);
          if (pruned === undefined) delete agent.model;
          else agent.model = pruned;
        });
      }
    }

    // 2. Delete the endpoint provider definition itself
    if (config.models?.providers?.[endpoint]) {
      delete config.models.providers[endpoint];
      deletedCount++; // Ensure count > 0 to signal success
    }

    if (deletedCount > 0) {
      this.writeConfigFile(config);
    }
    
    return deletedCount;
  }

  /**
   * Get the list of all defined endpoints in openclaw.json
   */
  getEndpoints(): any[] {
    try {
      const config = this.readConfigFile();
      if (!config) return [];
      const providers = config?.models?.providers;
      if (!providers || typeof providers !== 'object') return [];

      return Object.entries(providers)
        .filter(([id, meta]) => !this.isManagedImageGenerationBridgeProvider(id, meta))
        .map(([id, meta]: [string, any]) => ({
          id,
          baseUrl: meta?.baseUrl || '',
          apiKey: meta?.apiKey || '',
          api: meta?.api || 'openai-completions',
        }));
    } catch (err) {
      // 同上（readAvailableModels）：ConfigReadError 不是「没有端点」，往上抛。
      if (err instanceof ConfigReadError) throw err;
      console.error('Failed to read endpoints from openclaw.json:', err);
      return [];
    }
  }

  /**
   * Add or update an endpoint provider in openclaw.json
   */
  async saveEndpoint(id: string, endpointConfig: { baseUrl: string, apiKey: string, api: string }): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};

    const existing = config.models.providers[id];
    config.models.providers[id] = {
      ...existing, // preserve existing models array or other metadata
      baseUrl: endpointConfig.baseUrl.trim(),
      apiKey: endpointConfig.apiKey.trim(),
      api: endpointConfig.api,
      models: existing?.models || []
    };

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Update the model for an existing agent in openclaw.json
   * For 'main' agent: updates agents.defaults.model.primary
   * For other agents: updates agents.list[].model
   */
  async updateModel(
    agentId: string,
    model?: string | null,
    fallbackConfig?: { mode?: AgentFallbackMode; fallbacks?: string[] }
  ): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedModel = this.normalizeModelId(model);
    const normalizedFallbacks = this.normalizeFallbackIds(fallbackConfig?.fallbacks);
    const fallbackMode = fallbackConfig?.mode
      ?? (fallbackConfig ? (normalizedFallbacks.length > 0 ? 'custom' : 'disabled') : 'inherit');

    const idsToValidate = [
      ...(normalizedModel ? [normalizedModel] : []),
      ...normalizedFallbacks,
    ];
    this.validateModelIds(config, idsToValidate);

    if (agentId === 'main') {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};

      const globalConfig = this.readStoredModelValue(config.agents.defaults.model);
      const nextPrimary = normalizedModel || globalConfig.primary;
      if (!nextPrimary) {
        return false;
      }

      if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
        config.agents.defaults.model = {};
      }

      const prevDefaultSerialized = JSON.stringify(config.agents.defaults.model);
      config.agents.defaults.model.primary = nextPrimary;
      if (globalConfig.hasFallbacks || Object.prototype.hasOwnProperty.call(config.agents.defaults.model, 'fallbacks')) {
        config.agents.defaults.model.fallbacks = globalConfig.fallbacks;
      }

      const { entry, workspaceChanged } = this.ensureAgentEntry(config, 'main', this.getWorkspacePath('main'));
      const mainStoredModel = this.buildStoredModelValue(nextPrimary, fallbackMode, normalizedFallbacks);
      const modelChanged = this.assignModelValue(entry, mainStoredModel);
      const defaultChanged = JSON.stringify(config.agents.defaults.model) !== prevDefaultSerialized;

      if (!defaultChanged && !modelChanged && !workspaceChanged) {
        return false;
      }

      this.writeConfigFile(config);
      return true;
    }

    const { entry, created, workspaceChanged } = this.ensureAgentEntry(config, agentId, this.getWorkspacePath(agentId));
    const nextStoredModel = this.buildStoredModelValue(normalizedModel, fallbackMode, normalizedFallbacks);
    const changed = this.assignModelValue(entry, nextStoredModel);

    if (!changed && !created && !workspaceChanged) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }

  /**
   * Read the actual model configured for an agent from openclaw.json
   * For 'main': reads agents.defaults.model.primary
   * For others: reads agents.list[].model (or falls back to default primary)
   */
  readAgentModel(agentId: string): string | null {
    try {
      return this.readAgentModelConfig(agentId).resolvedModel;
    } catch (err) {
      // 裸 catch { return null } 会把「配置读不动」伪装成「这个 Agent 没配模型」——
      // 界面看起来一切正常，实际上根本没读到 openclaw.json。ConfigReadError 往上
      // 抛，让调用方（各路由已有的 try/catch，或已在错误路径里的调用点自己兜底）
      // 决定怎么处理；只有真正意料之外的错误才继续吞成 null。
      if (err instanceof ConfigReadError) throw err;
      return null;
    }
  }

  readAgentModelConfig(agentId: string): AgentModelConfigSnapshot {
    const config = this.readConfigFile();
    const globalConfig = config ? this.readStoredModelValue(config?.agents?.defaults?.model) : {
      primary: null,
      hasFallbacks: false,
      fallbacks: [],
    };

    if (!config) {
      return {
        model: null,
        modelOverride: null,
        fallbackMode: 'inherit',
        fallbacks: [],
        resolvedModel: null,
      };
    }

    if (agentId === 'main') {
      const mainEntry = Array.isArray(config.agents?.list)
        ? config.agents.list.find((item: any) => item.id === 'main')
        : null;
      const mainModel = this.readStoredModelValue(mainEntry?.model);
      const resolvedModel = this.normalizeModelId(mainModel.primary || globalConfig.primary);
      const modelOverride = this.normalizeModelId(mainModel.primary || globalConfig.primary);

      return {
        model: resolvedModel,
        modelOverride,
        fallbackMode: this.resolveFallbackMode(mainModel.hasFallbacks, mainModel.fallbacks),
        fallbacks: mainModel.fallbacks,
        resolvedModel,
      };
    }

    const entry = Array.isArray(config.agents?.list)
      ? config.agents.list.find((item: any) => item.id === agentId)
      : null;
    const stored = this.readStoredModelValue(entry?.model);
    const resolvedModel = this.normalizeModelId(stored.primary || globalConfig.primary);

    return {
      model: resolvedModel,
      modelOverride: stored.primary,
      fallbackMode: this.resolveFallbackMode(stored.hasFallbacks, stored.fallbacks),
      fallbacks: stored.fallbacks,
      resolvedModel,
    };
  }

  readGlobalModelConfig(): GlobalModelConfigSnapshot {
    const config = this.readConfigFile();
    if (!config) {
      return { primary: null, fallbacks: [] };
    }

    const stored = this.readStoredModelValue(config?.agents?.defaults?.model);
    return {
      primary: stored.primary,
      fallbacks: stored.fallbacks,
    };
  }

  readImageGenerationModelConfig(): ImageGenerationModelConfigSnapshot {
    const config = this.readConfigFile();
    if (!config) {
      return { primary: null, fallbacks: [] };
    }

    const uiStored = this.readUiImageGenerationModelConfig();
    if (uiStored?.primary) {
      const configuredIds = this.getConfiguredModelIds(config);
      if (configuredIds.size === 0 || configuredIds.has(uiStored.primary)) {
        return {
          primary: uiStored.primary,
          fallbacks: configuredIds.size === 0
            ? uiStored.fallbacks
            : uiStored.fallbacks.filter((id) => configuredIds.has(id)),
        };
      }
    }

    const stored = this.readStoredModelValue(config?.agents?.defaults?.imageGenerationModel);
    return {
      primary: stored.primary,
      fallbacks: stored.fallbacks,
    };
  }

  readImageGenerationEndpointModel(modelId: string): ImageGenerationEndpointModelSnapshot | null {
    const config = this.readConfigFile();
    if (!config) return null;

    const parts = this.splitModelRef(modelId);
    if (!parts) return null;

    const provider = this.getEndpointProviderConfig(config, parts.endpointId);
    if (!provider) return null;

    const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : '';
    const apiKey = provider.apiKey === undefined || provider.apiKey === null
      ? ''
      : String(provider.apiKey).trim();
    if (!baseUrl || !apiKey) return null;

    const headers: Record<string, string> = {};
    if (provider.headers && typeof provider.headers === 'object' && !Array.isArray(provider.headers)) {
      for (const [key, value] of Object.entries(provider.headers)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        if (value === undefined || value === null) continue;
        headers[key.trim()] = String(value);
      }
    }

    const authHeader = typeof provider.authHeader === 'string' && provider.authHeader.trim()
      ? provider.authHeader.trim()
      : undefined;

    return {
      id: modelId,
      endpointId: parts.endpointId,
      modelName: parts.modelName,
      baseUrl,
      apiKey,
      api: typeof provider.api === 'string' && provider.api.trim() ? provider.api.trim() : 'openai-completions',
      authHeader,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  }

  readEndpointModel(modelId: string): ImageGenerationEndpointModelSnapshot | null {
    return this.readImageGenerationEndpointModel(modelId);
  }

  async updateImageGenerationModelConfig(primary: string | null, fallbacks: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedPrimary = this.normalizeModelId(primary);
    const normalizedFallbacks = normalizedPrimary ? this.normalizeFallbackIds(fallbacks) : [];
    this.validateImageGenerationModelIds(config, [
      ...(normalizedPrimary ? [normalizedPrimary] : []),
      ...normalizedFallbacks,
    ]);

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};

    const previousSerialized = JSON.stringify(this.readImageGenerationModelConfig());
    const previousRuntimeSerialized = JSON.stringify(config.agents.defaults.imageGenerationModel ?? null);
    const selectedModelIds = [
      ...(normalizedPrimary ? [normalizedPrimary] : []),
      ...normalizedFallbacks,
    ];
    const canUseNativeRuntime = selectedModelIds.length > 0 && selectedModelIds.every((id) => {
      const parts = this.splitModelRef(id);
      return !parts || this.isNativeImageGenerationProvider(parts.endpointId);
    });

    if (!normalizedPrimary && normalizedFallbacks.length === 0) {
      delete config.agents.defaults.imageGenerationModel;
      this.pruneUnusedImageGenerationBridgeProviders(config, new Set());
    } else if (!canUseNativeRuntime) {
      delete config.agents.defaults.imageGenerationModel;
      this.pruneUnusedImageGenerationBridgeProviders(config, new Set());
    } else {
      const { runtime, bridgeChanged } = this.buildImageGenerationRuntimeConfig(
        config,
        normalizedPrimary,
        normalizedFallbacks,
      );

      if (!runtime.primary) {
        throw new Error('Failed to resolve image generation runtime model');
      }

      config.agents.defaults.imageGenerationModel = this.buildStoredModelValue(
        runtime.primary,
        runtime.fallbacks.length > 0 ? 'custom' : 'disabled',
        runtime.fallbacks,
      );

      if (bridgeChanged) {
        config.agents.defaults.imageGenerationModel = this.buildStoredModelValue(
          runtime.primary,
          runtime.fallbacks.length > 0 ? 'custom' : 'disabled',
          runtime.fallbacks,
        );
      }
    }

    const uiChanged = this.writeUiImageGenerationModelConfig(normalizedPrimary, normalizedFallbacks);
    const nextRuntimeSerialized = JSON.stringify(config.agents.defaults.imageGenerationModel ?? null);
    const nextSerialized = JSON.stringify({
      primary: normalizedPrimary,
      fallbacks: normalizedFallbacks,
    });

    if (previousSerialized === nextSerialized && previousRuntimeSerialized === nextRuntimeSerialized && !uiChanged) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }

  async updateGlobalFallbacks(fallbacks: string[]): Promise<boolean> {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedFallbacks = this.normalizeFallbackIds(fallbacks);
    this.validateModelIds(config, normalizedFallbacks);

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};

    const current = this.readStoredModelValue(config.agents.defaults.model);
    if (!config.agents.defaults.model || typeof config.agents.defaults.model !== 'object') {
      config.agents.defaults.model = {};
    }

    const previousSerialized = JSON.stringify({
      primary: current.primary,
      fallbacks: current.fallbacks,
    });

    if (current.primary) {
      config.agents.defaults.model.primary = current.primary;
    }
    config.agents.defaults.model.fallbacks = normalizedFallbacks;

    const nextSerialized = JSON.stringify({
      primary: this.normalizeModelId(config.agents.defaults.model.primary),
      fallbacks: this.normalizeFallbackIds(config.agents.defaults.model.fallbacks),
    });

    if (previousSerialized === nextSerialized) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }


  /**
   * Generic reader for any .md file in the agent workspace
   */
  readAgentFile(agentId: string, filename: string, defaultContent: string = ''): string {
    const workspaceDir = this.getWorkspacePath(agentId);
    const filePath = path.join(workspaceDir, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return defaultContent;
  }

  /**
   * Generic writer for any .md file in the agent workspace
   */
  writeAgentFile(agentId: string, filename: string, content: string): void {
    const workspaceDir = this.getWorkspacePath(agentId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    const filePath = path.join(workspaceDir, filename);
    fs.writeFileSync(filePath, content);
  }

  /**
   * Read USER.md content for a given agent. (kept for backwards compat)
   */
  readUserMd(agentId: string): string {
    return this.readAgentFile(agentId, 'USER.md', DEFAULT_USER_MD);
  }

  /**
   * Write USER.md content for a given agent. (kept for backwards compat)
   */
  writeUserMd(agentId: string, content: string): void {
    this.writeAgentFile(agentId, 'USER.md', content);
  }

  /**
   * Add or update agent entry in openclaw.json agents.list[]
   */
  private updateConfigList(
    agentId: string,
    workspaceDir: string,
    model?: string,
    fallbackMode: AgentFallbackMode = 'inherit',
    fallbacks: string[] = [],
    systemPromptMode: AgentSystemPromptMode = 'system',
    toolMode: AgentToolMode = 'full',
  ): boolean {
    const config = this.readConfigFile();
    if (!config) return false;

    const normalizedModel = this.normalizeModelId(model);
    const normalizedFallbacks = this.normalizeFallbackIds(fallbacks);
    this.validateModelIds(config, [
      ...(normalizedModel ? [normalizedModel] : []),
      ...normalizedFallbacks,
    ]);

    const { entry, created } = this.ensureAgentEntry(config, agentId, workspaceDir);
    let changed = created;
    if (entry.workspace !== workspaceDir) {
      entry.workspace = workspaceDir;
      changed = true;
    }

    const modelChanged = this.assignModelValue(
      entry,
      this.buildStoredModelValue(normalizedModel, fallbackMode, normalizedFallbacks)
    );

    const runtimeChanged = (() => {
      const previousSerialized = JSON.stringify({
        systemPromptOverride: entry.systemPromptOverride,
        tools: entry.tools,
      });
      const nextSystemPromptMode = this.normalizeSystemPromptMode(systemPromptMode);
      if (nextSystemPromptMode === 'agent') {
        entry.systemPromptOverride = this.buildAgentSystemPromptOverride(agentId);
      } else {
        delete entry.systemPromptOverride;
      }

      const nextToolMode = this.normalizeToolMode(toolMode);
      if (nextToolMode === 'off') {
        entry.tools = { deny: ['*'] };
      } else {
        entry.tools = { profile: nextToolMode };
      }

      return previousSerialized !== JSON.stringify({
        systemPromptOverride: entry.systemPromptOverride,
        tools: entry.tools,
      });
    })();

    if (!changed && !modelChanged && !runtimeChanged) {
      return false;
    }

    this.writeConfigFile(config);
    return true;
  }
}

export default AgentProvisioner;
