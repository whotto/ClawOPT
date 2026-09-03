/**
 * agents 名册的读写门面：统一 `agents.list[]`（旧）与 `agents.entries{}`（新）。
 *
 * ## 为什么需要它
 *
 * OpenClaw 2026.8 把配置里的 Agent 名册从数组改成了以 id 为键的对象。
 * ClawOPT 要在**同一份代码**里同时正确工作于 2026.7.x 与 2026.8.x，
 * 而不是分叉两个版本。
 *
 * ## 策略：跟随现状
 *
 * | 配置里有什么 | 读写落在哪 |
 * |---|---|
 * | 有 `entries` | entries |
 * | 只有 `list` | list |
 * | 两者都有 | **entries**，并出声——这是迁移到一半的状态 |
 * | 两者都没有 | 按探测到的引擎版本；**版本 unknown 时用 list** |
 *
 * ### 为什么 unknown 时选 list
 *
 * 两个方向的失败代价**不对称**：
 *
 * - 在 2026.8.x 上写 `list` → 多一个废弃键，doctor 一跑就迁移，**可恢复**
 * - 在 2026.7.x 上写 `entries` → 引擎**完全看不见**这个 Agent，**没有恢复路径**
 *
 * 朝代价小的方向失败。
 *
 * ### 为什么不主动迁移
 *
 * 生产机上有 7 个真实 Agent 全在 `list` 里。把它们迁到 `entries` 是
 * **`openclaw doctor` 的职责**，不是 ClawOPT 的——我们迁一半、或者迁的语义与
 * upstream 不一致，用户就得到一份两个工具都不认的配置。
 * 门面只保证「写到引擎正在读的那个地方」。
 */
import { isPlainObject } from './openclaw-config';
import { detectOpenClawVersion, usesEntriesSchema, type OpenClawVersionResult } from './openclaw-version';

/** 一条 Agent 名册记录。`id` 在 list 形状里是字段，在 entries 形状里是键。 */
export type RosterEntry = Record<string, unknown> & { id: string };

export type RosterShape = 'list' | 'entries';

export type RosterWarning =
  /** `list` 与 `entries` 同时存在——配置迁移到一半，写入以 entries 为准。 */
  | { readonly code: 'bothShapesPresent'; readonly listCount: number; readonly entryCount: number }
  /** 引擎版本探测不到，按保守形状（list）写。 */
  | { readonly code: 'versionUnknownDefaultingToList'; readonly reason: string };

export type RosterView = {
  readonly shape: RosterShape;
  readonly warnings: readonly RosterWarning[];
};

/**
 * 判定这份配置的名册该按哪种形状读写。
 *
 * **不修改传入的 config**，只做判定——判定与写入分开，
 * 是为了让「为什么落在这个形状」可以被单独断言。
 */
export function resolveRosterShape(
  config: Record<string, unknown>,
  version: OpenClawVersionResult = detectOpenClawVersion(),
): RosterView {
  const agents = isPlainObject(config.agents) ? config.agents : {};
  const hasList = Array.isArray(agents.list);
  const hasEntries = isPlainObject(agents.entries);
  const warnings: RosterWarning[] = [];

  if (hasList && hasEntries) {
    // 出声，不静默。两者并存意味着有人（doctor 或另一个工具）迁了一半，
    // 而我们接下来要写的那一侧，另一侧不会跟着变——用户需要知道。
    warnings.push({
      code: 'bothShapesPresent',
      listCount: (agents.list as unknown[]).length,
      entryCount: Object.keys(agents.entries as Record<string, unknown>).length,
    });
    return { shape: 'entries', warnings };
  }

  if (hasEntries) return { shape: 'entries', warnings };
  if (hasList) return { shape: 'list', warnings };

  // 两者都没有：全新配置。按引擎版本决定建哪一种。
  if (!version.known) {
    warnings.push({ code: 'versionUnknownDefaultingToList', reason: version.reason });
    return { shape: 'list', warnings };
  }
  return { shape: usesEntriesSchema(version) ? 'entries' : 'list', warnings };
}

/** 读出名册里的全部记录。形状差异在这一层抹平。 */
export function listRosterEntries(config: Record<string, unknown>, shape: RosterShape): RosterEntry[] {
  const agents = isPlainObject(config.agents) ? config.agents : {};

  if (shape === 'entries') {
    const entries = isPlainObject(agents.entries) ? agents.entries : {};
    return Object.entries(entries)
      .filter(([, value]) => isPlainObject(value))
      .map(([id, value]) => ({ ...(value as Record<string, unknown>), id }));
  }

  const list = Array.isArray(agents.list) ? agents.list : [];
  return list.filter(isPlainObject).map((item) => item as RosterEntry);
}

/** 按 id 找一条。找不到返回 `null`——**不返回一个空对象**，那会让调用方分不清。 */
export function findRosterEntry(
  config: Record<string, unknown>,
  shape: RosterShape,
  agentId: string,
): RosterEntry | null {
  return listRosterEntries(config, shape).find((e) => e.id === agentId) ?? null;
}

/**
 * 写入或更新一条记录。**原地改 `config`**，返回是否发生了变化。
 *
 * 「是否变化」由调用方用来决定要不要落盘——多写一次配置文件不是免费的
 * （它会触发 gateway 重载），所以这个返回值必须准确，不能永远返回 true。
 */
export function upsertRosterEntry(
  config: Record<string, unknown>,
  shape: RosterShape,
  entry: RosterEntry,
): boolean {
  if (!isPlainObject(config.agents)) config.agents = {};
  const agents = config.agents as Record<string, unknown>;

  if (shape === 'entries') {
    if (!isPlainObject(agents.entries)) agents.entries = {};
    const entries = agents.entries as Record<string, unknown>;
    const { id, ...rest } = entry;
    const before = JSON.stringify(entries[id]);
    // entries 形状里 id 是**键**，不重复存进值里——存两份就会有两个真值源，
    // 而它们迟早会分叉。
    entries[id] = { ...(isPlainObject(entries[id]) ? (entries[id] as object) : {}), ...rest };
    return before !== JSON.stringify(entries[id]);
  }

  if (!Array.isArray(agents.list)) agents.list = [];
  const list = agents.list as Record<string, unknown>[];
  const idx = list.findIndex((item) => isPlainObject(item) && item.id === entry.id);
  if (idx < 0) {
    list.push({ ...entry });
    return true;
  }
  const before = JSON.stringify(list[idx]);
  list[idx] = { ...list[idx], ...entry };
  return before !== JSON.stringify(list[idx]);
}

/**
 * 删一条。返回是否真的删掉了。
 *
 * 删空之后**把容器键一并删掉**，与本仓库既有的 `deprovision()` 行为保持一致——
 * 留一个空数组/空对象在配置里，会让「从来没建过 Agent」和「建过又都删了」
 * 长得不一样，而这个区别对引擎没有意义，只会让配置比较变噪声。
 */
export function removeRosterEntry(
  config: Record<string, unknown>,
  shape: RosterShape,
  agentId: string,
): boolean {
  if (!isPlainObject(config.agents)) return false;
  const agents = config.agents as Record<string, unknown>;

  if (shape === 'entries') {
    if (!isPlainObject(agents.entries)) return false;
    const entries = agents.entries as Record<string, unknown>;
    if (!(agentId in entries)) return false;
    delete entries[agentId];
    if (Object.keys(entries).length === 0) delete agents.entries;
    return true;
  }

  if (!Array.isArray(agents.list)) return false;
  const list = agents.list as Record<string, unknown>[];
  const before = list.length;
  agents.list = list.filter((item) => !(isPlainObject(item) && item.id === agentId));
  const changed = (agents.list as unknown[]).length !== before;
  if ((agents.list as unknown[]).length === 0) delete agents.list;
  return changed;
}

/** 把告警渲染成一行人话，供调用方打日志。空数组返回 `null`。 */
export function describeRosterWarnings(warnings: readonly RosterWarning[]): string | null {
  if (warnings.length === 0) return null;
  return warnings
    .map((w) =>
      w.code === 'bothShapesPresent'
        ? `openclaw.json 里 agents.list(${w.listCount} 条) 与 agents.entries(${w.entryCount} 条) 同时存在，`
          + '配置正处于迁移到一半的状态；本次写入以 entries 为准，list 一侧不会跟着变。'
          + '建议跑一次 `openclaw doctor --fix` 收敛。'
        : `探测不到 OpenClaw 版本（${w.reason}），新建名册按保守形状 agents.list 写。`
          + '若这台机器其实是 2026.8+，跑一次 `openclaw doctor --fix` 即可迁移。',
    )
    .join(' ');
}

/**
 * 拿到配置里那条记录的**真实引用**（不是副本）。找不到返回 `null`。
 *
 * ## 为什么必须区分它和 `findRosterEntry`
 *
 * `findRosterEntry` 返回的是副本（entries 形状下还要把 `id` 从键补回值里，
 * 天然只能是新对象）。而本仓库既有的调用方拿到 entry 之后是**直接改它**的：
 *
 * ```ts
 * entry.workspace = workspaceDir;
 * entry.tools = { profile: nextToolMode };
 * delete entry.systemPromptOverride;
 * ```
 *
 * 改在副本上等于什么都没写，而且**不会报错**——配置照常落盘，只是少了那些字段。
 * 这正是本项目反复修的那类失败（报成功、没生效），所以两个函数必须分开，
 * 名字也要让人一眼看出区别。
 *
 * **entries 形状下返回的对象里没有 `id`**（id 是键）。调用方若需要 id，
 * 用它自己传进来的那个——不要从这个对象上读。
 */
export function rosterEntryRef(
  config: Record<string, unknown>,
  shape: RosterShape,
  agentId: string,
): Record<string, unknown> | null {
  if (!isPlainObject(config.agents)) return null;
  const agents = config.agents as Record<string, unknown>;

  if (shape === 'entries') {
    const entries = isPlainObject(agents.entries) ? agents.entries : null;
    const value = entries?.[agentId];
    return isPlainObject(value) ? (value as Record<string, unknown>) : null;
  }

  const list = Array.isArray(agents.list) ? agents.list : [];
  const found = list.find((item) => isPlainObject(item) && (item as Record<string, unknown>).id === agentId);
  return isPlainObject(found) ? (found as Record<string, unknown>) : null;
}
