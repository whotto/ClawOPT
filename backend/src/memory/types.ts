/**
 * 记忆服务的对外契约（P6，spec 06 §4）。MCP 工具（`mcp-server`）、成长轨迹（`control/journey`）与记忆浏览页都只按这里的形状编码。
 *
 * 设计要点（实现以 `memory-service.ts` 为准）：
 * - 只有一种持久记忆：类型化卡片。键由服务端按「种类 + itemKey」生成，模型给的分类一律忽略；
 * - 修改一律是 supersede（新 id、revision+1、旧卡留作历史），带 `expectedRevision` 乐观并发；
 * - 作用域三级：profile（Agent）/ context（群等宿主定义的命名空间）/ session；宿主决定能读写哪些、默认写到哪；
 * - 来历（origin）由宿主盖章；证据（evidence）是宿主捕获的**可信用户消息**，模型不能伪造来源；
 * - 批量写原子：全部校验通过才在一个事务里提交，任何一条失败整批不生效并报出失败序号；
 * - 意图闸门（中英文，识别否定句）只是护栏之一，界面上的「记住 / 忘掉」动作由人发起，不经闸门。
 */

export const MEMORY_CARD_TYPES = ['preference', 'fact', 'decision', 'task', 'recipe', 'skill', 'constraint', 'correction'] as const;
export type MemoryCardType = (typeof MEMORY_CARD_TYPES)[number];

export const MEMORY_CARD_STATUSES = ['active', 'superseded', 'expired', 'deleted'] as const;
export type MemoryCardStatus = (typeof MEMORY_CARD_STATUSES)[number];

/** 作用域引用。profile 的 id 就是 Agent id（授权判定用的形状，外部运行时是 `ext:<运行时>`）。 */
export type MemoryScopeRef =
  | { type: 'profile'; id: string }
  | { type: 'context'; namespace: string; id: string }
  | { type: 'session'; id: string };

/** 宿主盖的来历章：不透明，服务只存不解释。 */
export type MemoryOrigin = { host: string; namespace: string; contextId: string };

export type MemoryEvidenceMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt?: string };

/** 写入策略：automatic = 按意图闸门与规则写；explicit-only = 没有明确「记住」意图一律拒写（检索照常）。 */
export type MemoryWritePolicy = 'automatic' | 'explicit-only';

/**
 * 一次调用的宿主上下文。MCP 路径由范围令牌推出来（运行的 Agent、会话、群），界面路径由登录用户推出来。
 */
export interface MemoryHostContext {
  /** 卡片所属的 profile（Agent）。 */
  profileId: string;
  origin: MemoryOrigin;
  recallScopes: MemoryScopeRef[];
  writeScopes: MemoryScopeRef[];
  /** 写入时没指定作用域落到哪（群聊 = 群 context）。 */
  defaultWriteScope: MemoryScopeRef;
  /** 这一轮宿主捕获的可信用户证据（不含路由信封、注入摘要、引用的历史）。 */
  evidence: MemoryEvidenceMessage[];
  policy: MemoryWritePolicy;
  /** 审计里的操作者：`agent:<id>`（经 MCP）或 `user:<用户名>`（界面）。 */
  actor: string;
  /** 界面上由人显式发起（「记住」「编辑」「删除」按钮）：视为明确意图，不经意图闸门。 */
  explicitUserAction?: boolean;
}

export interface MemoryCard {
  id: string;
  profileId: string;
  scope: MemoryScopeRef;
  origin: MemoryOrigin | null;
  kind: string;
  /** 服务端生成的规范键。 */
  key: string;
  domain: string;
  categoryPath: string;
  type: MemoryCardType;
  revision: number;
  status: MemoryCardStatus;
  title: string;
  content: string;
  value: unknown;
  confidence: number;
  importance: number;
  tags: string[];
  entities: string[];
  sourceMessageIds: string[];
  parentId: string | null;
  supersedesId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export class MemoryError extends Error {
  constructor(readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'MemoryError';
  }
}
