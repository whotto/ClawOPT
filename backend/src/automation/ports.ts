/**
 * 自动化模块对「执行平面」的全部依赖，收在这一个接口里。
 *
 * ## 为什么是接口
 *
 * 工作流节点、看板派活都要「让某个 Agent 跑一轮并等它结束」。这件事的实现属于运行协调器
 * （`runtime/coordinator`）：会话、中止、落库、用量、审批自动应答、业务事件。引擎和看板不该知道这些，
 * 所以只依赖 `WorkflowAgentRunner`。
 *
 * 正式实现是 `runner/coordinator-runner.ts`：每次运行是协调器里 `workflow` 表面的一个会话
 * （会话键 `workflow:<sessionId>`）。
 *
 * 测试与本机演示用 `runner/fake-runner.ts`（`CLAWOPT_WORKFLOW_FAKE_RUNNER=1`）。
 */

export type WorkflowAgentRef = {
  kind: 'openclaw' | 'external';
  /** openclaw：Agent id；external：运行时 id（如 `claude-code`）。 */
  id: string;
  /** external 时的运行时标识，与 `id` 相同；保留这一格给同一运行时的多份配置。 */
  runtime?: string;
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; mediaType: string; name: string }
  | { type: 'file'; path: string; mediaType: string; name: string };

export type ContentBlocks = ContentBlock[];

export type AgentRunRequest = {
  /** 本轮的会话 id，由调用方生成；节点转录按它回查。 */
  sessionId: string;
  agentRef: WorkflowAgentRef;
  input: ContentBlocks;
  /** 工作目录。外部运行时的 cwd；OpenClaw 忽略（它有自己的 Agent 工作区）。 */
  workspace: string;
  timeoutMs: number;
  /**
   * 运行中出现工具权限询问时怎么答：`once` 一次性允许；`deny` 一律拒绝。
   * 没有人值守的自动化只能二选一，不能把决定交给一个不存在的人。
   */
  autoApprove: 'once' | 'deny';
  signal: AbortSignal;
  /** 可选模型绑定（外部运行时）。导出工作流时丢弃。 */
  model?: string;
  /**
   * 这次运行的归属（外部运行时的运行时 home 按它定位与回收）：工作流节点是 `{工作流 id, 节点 id}`，
   * 看板派活是 `{'kanban', 任务 id}`。
   */
  owner?: { workflowId: string; nodeId: string };
};

export type AgentRunResult = {
  ok: boolean;
  output: string;
  error?: string;
  /** 失败是否因为超时（引擎据此区分「节点失败」与「整次运行到期」）。 */
  timedOut?: boolean;
  sessionId: string;
};

export interface WorkflowAgentRunner {
  runAndWait(req: AgentRunRequest): Promise<AgentRunResult>;
  abort(sessionId: string): Promise<void> | void;
  /** 运行被删除：丢掉这些会话在执行平面留下的记录（协调器会话行、工具调用；用量是账，保留）。 */
  discardSessions(sessionIds: string[]): void;
}

export type AgentAvailability = { available: true } | { available: false; reason: string };

/** 节点可选的 Agent 名册（OpenClaw 角色 + 外部运行时），以及可用性与技能解析。 */
export interface AgentDirectory {
  list(): Promise<AgentDirectoryEntry[]> | AgentDirectoryEntry[];
  availability(ref: WorkflowAgentRef): AgentAvailability;
  /** 技能名 → SKILL.md 全文；找不到返回 null。 */
  readSkill(ref: WorkflowAgentRef, skill: string): string | null;
  listSkills(ref: WorkflowAgentRef): string[];
}

export type AgentDirectoryEntry = {
  ref: WorkflowAgentRef;
  name: string;
  available: boolean;
  reason?: string;
  skills: string[];
  /** 外部运行时：支持的模式（global / scoped）与是否有真审批。 */
  modes?: string[];
  approvals?: boolean;
};

/** 附件引用（`/uploads/<name>`）→ 可读的绝对路径；不可服务时返回 null。 */
export type AttachmentResolver = (url: string) => { path: string; mediaType: string; name: string } | null;

export type BusinessEventPublisher = (type: string, payload: Record<string, unknown>) => void;
