/**
 * 服务商编辑器（spec 05 F2 的 ClawOPT 版）：`openclaw.json` 里 `models.providers.<id>`。
 *
 * - **凭据只出不进**：视图只有 `hasApiKey`；保存时 `apiKey` 空串 = 保持原值。
 * - **版本号含密钥值**：`revision = computeRevision(原始条目)`，别处换了 key 也算并发修改。
 * - **比对与写入在同一把锁里**：经 SafeFileStore 的 `updateJson`，锁内重新读条目、比版本号、再写；
 *   锁外比完再写，中间被 CLI 或网关改了照样丢更新。
 * - 上下文长度覆盖写进引擎自己的字段 `models.providers.<id>.models[i].contextWindow`，
 *   不在 ClawOPT 里另存一份（另存就是影子配置，引擎看不到）。
 */
import { computeRevision } from '../../core/http';
import { sharedFileStore, type SafeFileStore } from '../../core/files';
import { getOpenClawConfigPath, readOpenClawConfigSafe } from '../../openclaw';
import { ControlInputError } from '../shared/control-http';

type Raw = Record<string, unknown>;

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_CONTEXT_LENGTH = 100_000_000;

export class ProviderRevisionConflict extends Error {
  constructor(readonly current: { revision: string; value: ProviderView | null }) {
    super('REVISION_CONFLICT');
  }
}

export type ProviderView = {
  id: string;
  baseUrl: string;
  api: string;
  hasApiKey: boolean;
  modelCount: number;
  contextLengths: Record<string, number>;
  revision: string;
};

const isObject = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);

export function assertProviderId(id: unknown): string {
  if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) throw new ControlInputError('models.invalidProviderId');
  return id;
}

export function providerView(id: string, entry: Raw): ProviderView {
  const models = Array.isArray(entry.models) ? entry.models.filter(isObject) : [];
  const contextLengths: Record<string, number> = {};
  for (const model of models) {
    if (typeof model.id === 'string' && typeof model.contextWindow === 'number') contextLengths[model.id] = model.contextWindow;
  }
  return {
    id,
    baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
    api: typeof entry.api === 'string' ? entry.api : 'openai-completions',
    hasApiKey: typeof entry.apiKey === 'string' && entry.apiKey !== '',
    modelCount: models.length,
    contextLengths,
    revision: computeRevision(entry),
  };
}

export function validateBaseUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || /[\r\n]/.test(text)) throw new ControlInputError('models.invalidBaseUrl');
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ControlInputError('models.invalidBaseUrl');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new ControlInputError('models.invalidBaseUrl');
  }
  return text;
}

/** 纯函数：在一份配置上应用保存。返回新条目（调用方负责落盘）。 */
export function applyProviderSave(existing: Raw | null, input: { baseUrl: unknown; api: unknown; apiKey?: unknown }): Raw {
  const baseUrl = validateBaseUrl(input.baseUrl);
  const api = typeof input.api === 'string' && /^[a-z0-9-]{1,64}$/.test(input.api) ? input.api : null;
  if (!api) throw new ControlInputError('models.invalidApi');
  const apiKeyInput = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (/[\r\n]/.test(apiKeyInput)) throw new ControlInputError('models.invalidApiKey');
  const next: Raw = { ...(existing ?? {}), baseUrl, api, models: Array.isArray(existing?.models) ? existing!.models : [] };
  // 空串 = 保持原值；原来没有 key 就不写这个字段。
  if (apiKeyInput) next.apiKey = apiKeyInput;
  else if (typeof existing?.apiKey === 'string') next.apiKey = existing.apiKey;
  else delete next.apiKey;
  return next;
}

/** 纯函数：上下文长度补丁。`null` 删除覆盖；模型条目不存在时新建一个最小条目。 */
export function applyContextLengths(entry: Raw, patch: unknown): Raw {
  if (!isObject(patch)) throw new ControlInputError('models.invalidContextLength');
  const models = (Array.isArray(entry.models) ? entry.models : []).map((model) => (isObject(model) ? { ...model } : model));
  for (const [modelId, value] of Object.entries(patch)) {
    if (!modelId || modelId.length > 200 || /[\r\n]/.test(modelId)) throw new ControlInputError('models.invalidContextLength');
    if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_CONTEXT_LENGTH)) {
      throw new ControlInputError('models.invalidContextLength');
    }
    const index = models.findIndex((model) => isObject(model) && model.id === modelId);
    if (index === -1) {
      if (value !== null) models.push({ id: modelId, name: modelId, contextWindow: value });
      continue;
    }
    const model = models[index] as Raw;
    if (value === null) delete model.contextWindow;
    else model.contextWindow = value;
  }
  return { ...entry, models };
}

export function createProviderEditor(deps: { fileStore?: SafeFileStore; configPath?: () => string; readConfig?: () => Raw | null } = {}) {
  const fileStore = deps.fileStore ?? sharedFileStore;
  const configPath = deps.configPath ?? getOpenClawConfigPath;
  const readConfig = deps.readConfig ?? (() => readOpenClawConfigSafe() as Raw | null);

  function readEntry(id: string): Raw | null {
    const config = readConfig();
    const providers = isObject(config?.models) && isObject((config!.models as Raw).providers) ? (config!.models as Raw).providers as Raw : {};
    return isObject(providers[id]) ? providers[id] as Raw : null;
  }

  function list(): ProviderView[] {
    const config = readConfig();
    const providers = isObject(config?.models) && isObject((config!.models as Raw).providers) ? (config!.models as Raw).providers as Raw : {};
    return Object.entries(providers).filter(([, entry]) => isObject(entry)).map(([id, entry]) => providerView(id, entry as Raw));
  }

  /** 锁内：读条目 → 比版本（`required` 时缺版本即冲突）→ 变换 → 写。 */
  async function mutate(id: string, requested: string | null, options: { allowCreate: boolean }, transform: (entry: Raw | null) => Raw): Promise<{ before: string | null; after: string; created: boolean }> {
    const outcome = await fileStore.updateJson<Raw, { before: string | null; after?: string; created: boolean; conflict?: { revision: string; value: ProviderView | null } }>(configPath(), (current) => {
      if (!current) throw new ControlInputError('models.configMissing', 409);
      const models = isObject(current.models) ? current.models as Raw : {};
      const providers = isObject(models.providers) ? models.providers as Raw : {};
      const existing = isObject(providers[id]) ? providers[id] as Raw : null;
      const before = existing ? computeRevision(existing) : null;
      if (existing && requested !== before) {
        return { abort: true, result: { before, created: false, conflict: { revision: before!, value: providerView(id, existing) } } };
      }
      if (!existing && !options.allowCreate) throw new ControlInputError('models.providerNotFound', 404);
      const nextEntry = transform(existing);
      const next = { ...current, models: { ...models, providers: { ...providers, [id]: nextEntry } } };
      return { next, result: { before, after: computeRevision(nextEntry), created: !existing } };
    });
    const result = outcome.result!;
    if (result.conflict) throw new ProviderRevisionConflict(result.conflict);
    return { before: result.before, after: result.after!, created: result.created };
  }

  async function save(idRaw: unknown, input: { baseUrl: unknown; api: unknown; apiKey?: unknown }, requested: string | null) {
    const id = assertProviderId(idRaw);
    const fields: string[] = [];
    const outcome = await mutate(id, requested, { allowCreate: true }, (existing) => {
      const next = applyProviderSave(existing, input);
      for (const field of ['baseUrl', 'api', 'apiKey']) if (existing?.[field] !== next[field]) fields.push(field);
      return next;
    });
    return { ...outcome, fields };
  }

  async function setContextLengths(idRaw: unknown, patch: unknown, requested: string | null) {
    const id = assertProviderId(idRaw);
    return mutate(id, requested, { allowCreate: false }, (existing) => applyContextLengths(existing!, patch));
  }

  return { list, readEntry, save, setContextLengths };
}

export type ProviderEditor = ReturnType<typeof createProviderEditor>;
