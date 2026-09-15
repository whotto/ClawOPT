/**
 * 自动化模块对「执行平面」的全部依赖，收在这一个接口里。
 *
 * ## 为什么是接口
 *
 * 工作流节点、看板派活都要「让某个 Agent 跑一轮并等它结束」。这件事的正式实现属于
 * 运行协调器（`runtime/coordinator`，并行开发中）：队列、插入、中止、续传、落库、审批自动应答。
 * 引擎不该知道这些，也不该等协调器落地才能跑——所以只依赖 `WorkflowAgentRunner`。
 *
 * 现在的实现是 `runner/existing-path-runner.ts`：**薄适配**，走 ClawOPT 已有的两条路径
 * （OpenClaw 网关 chat.send + agent.wait；外部运行时的本机执行器）。协调器落地后替换的只是
 * 那一个文件与 `bootstrap/context.ts` 里的一行装配，引擎、看板、测试都不动。
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
};

/** 附件引用（`/uploads/<name>`）→ 可读的绝对路径；不可服务时返回 null。 */
export type AttachmentResolver = (url: string) => { path: string; mediaType: string; name: string } | null;

export type BusinessEventPublisher = (type: string, payload: Record<string, unknown>) => void;
