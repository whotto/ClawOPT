/**
 * 模型目录缓存（spec 05 F9）：每个服务商一份从 `/models` 拉回的列表，带一步撤销。
 *
 * 四条规则，全是「别让一次坏刷新毁掉好数据」：
 * 1. **空结果 = 探测失败**，绝不当成「上游把模型全删了」；
 * 2. **会移除模型时先预览**，没带 `confirm` 只回差异，不写；
 * 3. **受保护模型不丢**：当前默认模型、以及 openclaw.json 里已配置在这个服务商下的模型，
 *    上游没列出时保留为 `unavailable`（界面置灰），而不是从目录里消失；
 * 4. **一步撤销**：列表真的变了才写快照；撤销 = 换回快照并清空快照。
 */
import type { DB } from '../../core/db';

export type CatalogEntry = {
  providerId: string;
  baseUrl: string;
  models: string[];
  unavailableModels: string[];
  source: 'live';
  updatedAt: number;
  restoreAvailable: boolean;
  previousUpdatedAt: number | null;
};

export type CatalogDiff = { added: string[]; removed: string[]; unchanged: string[]; keptUnavailable: string[] };

export class CatalogRefreshError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
  }
}

/** 纯函数：给出刷新计划。空结果抛 `models.catalogEmpty`。 */
export function planCatalogRefresh(input: {
  currentModels: string[];
  currentUnavailable: string[];
  fetched: string[];
  protectedModels: string[];
}): { diff: CatalogDiff; next: { models: string[]; unavailableModels: string[] }; changed: boolean; requiresConfirmation: boolean } {
  const fetched = [...new Set(input.fetched)].sort();
  if (fetched.length === 0) throw new CatalogRefreshError('models.catalogEmpty');
  const fetchedSet = new Set(fetched);
  const before = new Set([...input.currentModels, ...input.currentUnavailable]);
  const protectedSet = new Set(input.protectedModels);
  const keptUnavailable = [...protectedSet].filter((model) => !fetchedSet.has(model)).sort();
  const removed = [...before].filter((model) => !fetchedSet.has(model) && !protectedSet.has(model)).sort();
  const added = fetched.filter((model) => !before.has(model));
  const unchanged = fetched.filter((model) => before.has(model));
  const next = { models: fetched, unavailableModels: keptUnavailable };
  const changed = JSON.stringify([...input.currentModels].sort()) !== JSON.stringify(next.models)
    || JSON.stringify([...input.currentUnavailable].sort()) !== JSON.stringify(next.unavailableModels);
  return { diff: { added, removed, unchanged, keptUnavailable }, next, changed, requiresConfirmation: removed.length > 0 };
}

type Row = {
  provider_id: string;
  base_url: string;
  models: string;
  unavailable_models: string;
  source: string;
  updated_at: number;
  previous_models: string | null;
  previous_unavailable_models: string | null;
  previous_updated_at: number | null;
};

const parseList = (text: string | null): string[] => {
  try {
    const value = JSON.parse(text ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

function toEntry(row: Row): CatalogEntry {
  return {
    providerId: row.provider_id,
    baseUrl: row.base_url,
    models: parseList(row.models),
    unavailableModels: parseList(row.unavailable_models),
    source: 'live',
    updatedAt: row.updated_at,
    restoreAvailable: row.previous_models !== null,
    previousUpdatedAt: row.previous_updated_at,
  };
}

export function createModelCatalogStore(deps: { db: DB; now?: () => number }) {
  const sql = deps.db.connection();
  const now = deps.now ?? Date.now;

  function get(providerId: string): CatalogEntry | null {
    const row = sql.prepare('SELECT * FROM model_catalog WHERE provider_id = ?').get(providerId) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** 写入新列表；只有真的变了才把旧列表存成快照。 */
  function apply(providerId: string, baseUrl: string, next: { models: string[]; unavailableModels: string[] }): CatalogEntry {
    const existing = sql.prepare('SELECT * FROM model_catalog WHERE provider_id = ?').get(providerId) as Row | undefined;
    const ts = now();
    const models = JSON.stringify(next.models);
    const unavailable = JSON.stringify(next.unavailableModels);
    if (!existing) {
      sql.prepare('INSERT INTO model_catalog (provider_id, base_url, models, unavailable_models, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(providerId, baseUrl, models, unavailable, 'live', ts);
    } else if (existing.models !== models || existing.unavailable_models !== unavailable) {
      sql.prepare('UPDATE model_catalog SET base_url = ?, models = ?, unavailable_models = ?, source = ?, updated_at = ?, previous_models = ?, previous_unavailable_models = ?, previous_updated_at = ? WHERE provider_id = ?')
        .run(baseUrl, models, unavailable, 'live', ts, existing.models, existing.unavailable_models, existing.updated_at, providerId);
    } else {
      sql.prepare('UPDATE model_catalog SET base_url = ?, updated_at = ? WHERE provider_id = ?').run(baseUrl, ts, providerId);
    }
    return get(providerId)!;
  }

  function restore(providerId: string): CatalogEntry {
    const existing = sql.prepare('SELECT * FROM model_catalog WHERE provider_id = ?').get(providerId) as Row | undefined;
    if (!existing || existing.previous_models === null) throw new CatalogRefreshError('models.catalogNoSnapshot');
    sql.prepare('UPDATE model_catalog SET models = ?, unavailable_models = ?, updated_at = ?, previous_models = NULL, previous_unavailable_models = NULL, previous_updated_at = NULL WHERE provider_id = ?')
      .run(existing.previous_models, existing.previous_unavailable_models ?? '[]', existing.previous_updated_at ?? now(), providerId);
    return get(providerId)!;
  }

  function remove(providerId: string): void {
    sql.prepare('DELETE FROM model_catalog WHERE provider_id = ?').run(providerId);
  }

  return { get, apply, restore, remove };
}

export type ModelCatalogStore = ReturnType<typeof createModelCatalogStore>;

// ---- 可见性（spec 05 F11）：只影响界面挑选器，引擎配置不动 ----

export type VisibilityRule = { mode: 'all' | 'include'; models: string[] };

export function createModelPrefsStore(deps: { db: DB; now?: () => number }) {
  const sql = deps.db.connection();
  const now = deps.now ?? Date.now;
  return {
    getAll(): Map<string, VisibilityRule> {
      const rows = sql.prepare('SELECT provider_id, visibility_mode, visible_models FROM model_prefs').all() as Array<{ provider_id: string; visibility_mode: 'all' | 'include'; visible_models: string }>;
      return new Map(rows.map((row) => [row.provider_id, { mode: row.visibility_mode, models: parseList(row.visible_models) }]));
    },
    setVisibility(providerId: string, rule: VisibilityRule): void {
      if (rule.mode === 'all') {
        sql.prepare('DELETE FROM model_prefs WHERE provider_id = ?').run(providerId);
        return;
      }
      sql.prepare('INSERT INTO model_prefs (provider_id, visibility_mode, visible_models, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET visibility_mode = excluded.visibility_mode, visible_models = excluded.visible_models, updated_at = excluded.updated_at')
        .run(providerId, 'include', JSON.stringify([...new Set(rule.models)].sort()), now());
    },
  };
}

export type ModelPrefsStore = ReturnType<typeof createModelPrefsStore>;

/**
 * 某个服务商下哪些模型在挑选器里隐藏。**失效时放开**：白名单一个现存模型都没命中（过期规则），
 * 就当没有规则——否则一条过期规则能让整个服务商在挑选器里永久消失、且无从恢复。
 */
export function hiddenModels(available: string[], rule: VisibilityRule | undefined): Set<string> {
  if (!rule || rule.mode !== 'include') return new Set();
  const include = new Set(rule.models);
  if (!available.some((model) => include.has(model))) return new Set();
  return new Set(available.filter((model) => !include.has(model)));
}
