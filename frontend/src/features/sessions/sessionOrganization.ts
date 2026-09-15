// 侧栏会话组织（P1b）：置顶、分类、Recent、归档、只看人建的——纯函数，带单测。
//
// 服务端 `GET /api/session-organization` 按用户给分类与每个会话的归属；这里只负责把「看得见的会话列表」排成分组。
// 置顶按账号存在服务端（侧栏「收藏」是全局配置、不分用户，不能拿来当每个人的置顶）。

export type SessionCategory = { id: number; name: string };

export type SessionOrgInfo = {
  categoryId: number | null;
  archived: boolean;
  /** 置顶时间（epoch ms）；null = 没置顶。 */
  pinnedAt: number | null;
  title: string | null;
  titleSource: 'auto' | 'runtime' | 'manual' | null;
  humanCreated: boolean;
  parentSessionId: string | null;
  forkPointMessageId: number | null;
  lastActivityAt: number | null;
};

export type SessionOrganization = {
  categories: SessionCategory[];
  sessions: Record<string, SessionOrgInfo>;
};

export type SessionSection<T> =
  | { kind: 'pinned'; key: 'pinned'; items: T[] }
  | { kind: 'recent'; key: 'recent'; items: T[] }
  | { kind: 'category'; key: string; category: SessionCategory; items: T[] }
  | { kind: 'uncategorized'; key: 'uncategorized'; items: T[] }
  | { kind: 'archived'; key: 'archived'; items: T[] };

export const RECENT_COUNT_MIN = 1;
export const RECENT_COUNT_MAX = 100;
export const RECENT_COUNT_DEFAULT = 5;

export function clampRecentCount(value: unknown): number {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric)) return RECENT_COUNT_DEFAULT;
  return Math.min(RECENT_COUNT_MAX, Math.max(RECENT_COUNT_MIN, numeric));
}

export function normalizeOrganization(payload: any): SessionOrganization {
  const categories = Array.isArray(payload?.categories)
    ? payload.categories.filter((c: any) => Number.isInteger(c?.id) && typeof c?.name === 'string').map((c: any) => ({ id: c.id, name: c.name }))
    : [];
  const sessions: Record<string, SessionOrgInfo> = {};
  for (const [id, raw] of Object.entries(payload?.sessions ?? {})) {
    const info = raw as any;
    sessions[id] = {
      categoryId: Number.isInteger(info?.categoryId) ? info.categoryId : null,
      archived: info?.archived === true,
      pinnedAt: typeof info?.pinnedAt === 'number' && info.pinnedAt > 0 && info?.archived !== true ? info.pinnedAt : null,
      title: typeof info?.title === 'string' ? info.title : null,
      titleSource: ['auto', 'runtime', 'manual'].includes(info?.titleSource) ? info.titleSource : null,
      humanCreated: info?.humanCreated !== false,
      parentSessionId: typeof info?.parentSessionId === 'string' ? info.parentSessionId : null,
      forkPointMessageId: Number.isInteger(info?.forkPointMessageId) ? info.forkPointMessageId : null,
      lastActivityAt: typeof info?.lastActivityAt === 'number' ? info.lastActivityAt : null,
    };
  }
  return { categories, sessions };
}

/**
 * 分组规则：
 * - 「只看人建的」开着时先滤掉诊断 / 自动化会话；
 * - 置顶：最上面一组，后置顶的在上；置顶的会话**离开**它的分类 / 未分类与 Recent（已经在最上面了，不重复出现）；
 * - Recent：未归档里最近活动的前 N 个（快捷入口，**不**把会话从它的分类里拿走）；没有活动时间的不进 Recent；
 * - 分类：只列非空的，按名字排；指向不存在分类的归属当未分类；
 * - 归档：单独一组，不进 Recent、不进分类。
 * 会话本身的顺序保持传进来的顺序（侧栏拖拽排序的结果）。
 */
export function buildSessionSections<T extends { id: string }>(
  sessions: T[],
  organization: SessionOrganization | null,
  options: { humanOnly: boolean; recentCount: number; showRecent: boolean },
): SessionSection<T>[] {
  const infoOf = (id: string) => organization?.sessions[id];
  const visible = options.humanOnly ? sessions.filter((s) => infoOf(s.id)?.humanCreated !== false) : sessions;
  const unarchived = visible.filter((s) => !infoOf(s.id)?.archived);
  const archived = visible.filter((s) => infoOf(s.id)?.archived);
  const pinned = unarchived
    .filter((s) => typeof infoOf(s.id)?.pinnedAt === 'number')
    .sort((a, b) => (infoOf(b.id)!.pinnedAt as number) - (infoOf(a.id)!.pinnedAt as number));
  const active = unarchived.filter((s) => typeof infoOf(s.id)?.pinnedAt !== 'number');
  const sections: SessionSection<T>[] = [];
  if (pinned.length > 0) sections.push({ kind: 'pinned', key: 'pinned', items: pinned });

  if (options.showRecent && organization) {
    const recent = active
      .filter((s) => typeof infoOf(s.id)?.lastActivityAt === 'number' && (infoOf(s.id)!.lastActivityAt as number) > 0)
      .sort((a, b) => (infoOf(b.id)!.lastActivityAt as number) - (infoOf(a.id)!.lastActivityAt as number))
      .slice(0, clampRecentCount(options.recentCount));
    if (recent.length > 0) sections.push({ kind: 'recent', key: 'recent', items: recent });
  }

  const categories = [...(organization?.categories ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(categories.map((c) => c.id));
  for (const category of categories) {
    const items = active.filter((s) => infoOf(s.id)?.categoryId === category.id);
    if (items.length > 0) sections.push({ kind: 'category', key: `category:${category.id}`, category, items });
  }
  const uncategorized = active.filter((s) => {
    const categoryId = infoOf(s.id)?.categoryId ?? null;
    return categoryId === null || !known.has(categoryId);
  });
  sections.push({ kind: 'uncategorized', key: 'uncategorized', items: uncategorized });
  if (archived.length > 0) sections.push({ kind: 'archived', key: 'archived', items: archived });
  return sections;
}

/** 批量删除结果 → 提示：全部成功、部分失败（列出失败的名字）、全部失败。 */
export function summarizeBatchDelete(
  result: { deleted?: unknown; failed?: unknown },
  nameOf: (id: string) => string,
): { kind: 'ok' | 'partial' | 'failed'; deleted: number; failedNames: string[] } {
  const deleted = Array.isArray(result.deleted) ? result.deleted.length : 0;
  const failed = Array.isArray(result.failed) ? result.failed.map((id) => nameOf(String(id))) : [];
  if (failed.length === 0) return { kind: 'ok', deleted, failedNames: [] };
  return { kind: deleted > 0 ? 'partial' : 'failed', deleted, failedNames: failed };
}

/** 按浏览器记的侧栏偏好（折叠了哪些组、Recent 数量、只看人建的）：读坏了按缺省，不写回。 */
export type SessionOrgPrefs = { collapsed: string[]; recentCount: number; showRecent: boolean; humanOnly: boolean };

export const SESSION_ORG_PREFS_KEY = 'clawopt_session_org_prefs';

export function parseSessionOrgPrefs(raw: string | null): SessionOrgPrefs {
  const fallback: SessionOrgPrefs = { collapsed: [], recentCount: RECENT_COUNT_DEFAULT, showRecent: true, humanOnly: false };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw);
    return {
      collapsed: Array.isArray(value?.collapsed) ? value.collapsed.filter((key: unknown) => typeof key === 'string').slice(0, 200) : [],
      recentCount: clampRecentCount(value?.recentCount ?? RECENT_COUNT_DEFAULT),
      showRecent: value?.showRecent !== false,
      humanOnly: value?.humanOnly === true,
    };
  } catch {
    return fallback;
  }
}
