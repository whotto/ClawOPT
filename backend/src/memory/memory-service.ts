/**
 * 记忆服务（sidecar，引擎无关）。独立 SQLite 文件 `<数据目录>/memory/memory.sqlite`，FTS5 检索，可选嵌入钩子。
 *
 * 骨架：方法签名是契约（MCP 工具与成长轨迹按它编码），实现由 P6 记忆分支补齐。
 */
import type { MemoryCard, MemoryHostContext, MemoryScopeRef } from './types';

export type MemoryServiceDeps = {
  /** SQLite 文件路径；`:memory:` 只给测试（此时写工具拒绝，说明是临时库）。 */
  dbPath: string;
  now?: () => number;
};

export type MemorySearchInput = {
  query?: string;
  domain?: string;
  categoryPrefix?: string;
  types?: string[];
  kinds?: string[];
  key?: string;
  value?: string;
  tags?: string[];
  entities?: string[];
  limit?: number;
  all?: boolean;
};

export type MemoryOmission = { id: string; reason: 'expired' | 'superseded' | 'low_confidence' | 'conflict_lost' | 'over_limit' };

export type MemorySearchResult = { exact: MemoryCard[]; relevant: MemoryCard[]; omitted: MemoryOmission[] };

export type MemoryWriteOperation =
  | { op: 'create'; kind: string; itemKey?: string; title: string; content: string; value?: unknown; scope?: MemoryScopeRef; tags?: string[]; entities?: string[]; sourceMessageIds?: string[]; type?: string }
  | { op: 'update'; targetId: string; expectedRevision: number; title?: string; content?: string; value?: unknown; valuePatch?: Record<string, unknown>; unsetValueFields?: string[]; tags?: string[]; entities?: string[]; sourceMessageIds?: string[] }
  | { op: 'expire'; targetId: string; expectedRevision: number }
  | { op: 'delete'; targetId: string; expectedRevision: number; hard?: boolean };

export type MemoryWriteResult = {
  done: true;
  results: Array<{ index: number; op: string; outcome: 'created' | 'superseded' | 'noop' | 'expired' | 'deleted'; card: MemoryCard | null }>;
  note: string;
};

export type MemoryForgetInput = {
  all?: boolean;
  targets?: Array<{ id: string; revision: number }>;
  id?: string;
  revision?: number;
  filter?: { domain?: string; categoryPrefix?: string; type?: string; key?: string; value?: string };
};

export type MemoryRecallResult = { cards: MemoryCard[]; omittedCount: number; text: string };

export type MemoryListInput = { profileId?: string | null; profileIds?: string[] | null; query?: string; status?: string; limit?: number; offset?: number };

export function createMemoryService(_deps: MemoryServiceDeps) {
  return {
    async search(_ctx: MemoryHostContext, _input: MemorySearchInput): Promise<MemorySearchResult> {
      return { exact: [], relevant: [], omitted: [] };
    },
    async get(_ctx: MemoryHostContext, _input: { id: string }): Promise<MemoryCard | null> {
      return null;
    },
    async write(_ctx: MemoryHostContext, _input: { operations: MemoryWriteOperation[] }): Promise<MemoryWriteResult> {
      return { done: true, results: [], note: '' };
    },
    async forget(_ctx: MemoryHostContext, _input: MemoryForgetInput): Promise<{ done: true; deleted: number }> {
      return { done: true, deleted: 0 };
    },
    async recall(_ctx: MemoryHostContext, _input: { query?: string; tokenBudget?: number }): Promise<MemoryRecallResult> {
      return { cards: [], omittedCount: 0, text: '' };
    },
    /** 管理面：列表（含非 active，按状态过滤）。 */
    list(_input: MemoryListInput): { cards: MemoryCard[]; total: number } {
      return { cards: [], total: 0 };
    },
    /** 成长轨迹与图谱：某个 profile 的全部卡片（含历史版本）。 */
    listAllForProfile(_profileId: string): MemoryCard[] {
      return [];
    },
    close(): void {},
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
