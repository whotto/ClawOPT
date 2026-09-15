/**
 * 一次运行在内存里的全部可变状态。持久化的真相在 run-store；这里只是调度要用的工作副本，
 * 进程重启即丢——所以重启恢复一律按失败收尾，不试图续跑。
 */
import type { AgentDirectory, AttachmentResolver, BusinessEventPublisher, WorkflowAgentRunner } from '../ports';
import type { RunRecord, RunStore } from './run-store';
import type {
  CompiledGraph,
  CompiledLoop,
  DecisionStatus,
  IterationPath,
  NodeRuntimeStatus,
  WorkflowEdge,
  WorkflowNode,
} from './types';

export type FatalKind = 'canceled' | 'timeout' | 'approval_rejected' | 'evidence' | 'budget' | 'internal';

/** 让整次运行立刻结束的错误。节点失败不是它——节点失败按路由继续走。 */
export class RunFatal extends Error {
  constructor(readonly kind: FatalKind, message: string, readonly code: string) {
    super(message);
    this.name = 'RunFatal';
  }
}

export const RUN_CANCELED_MESSAGE = 'Workflow run canceled by user';
export const runTimeoutMessage = (ms: number | null) => `workflow run timed out after ${ms ?? 0}ms`;

export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }

  /** 致命错误时放行所有等待者，让它们自己看到 fatal 后退出。 */
  drain(): void {
    const waiters = this.waiters;
    this.waiters = [];
    // 醒来者会 +1 再立刻 release，短暂超过上限无妨：它们只做 fatal 检查，不会启动 Agent。
    for (const wake of waiters) wake();
  }
}

export type NodeOutput = { output?: string; error?: string; executionId: string | null };

export type FailureRecord = {
  executionId: string;
  nodeId: string;
  error: string;
  path: IterationPath;
  handled: boolean;
  resolved: boolean;
};

export type PendingApproval = { nodeId: string; executionId: string; resolve: (approved: boolean) => void };

export type RunDeps = {
  runStore: RunStore;
  runner: WorkflowAgentRunner;
  directory: AgentDirectory;
  resolveAttachment: AttachmentResolver;
  publishEvent: BusinessEventPublisher;
  onStatusChange: (ctx: RunContext) => void;
  now: () => number;
};

export class RunContext {
  readonly nodeById = new Map<string, WorkflowNode>();
  readonly forwardOut = new Map<string, WorkflowEdge[]>();
  readonly forwardIn = new Map<string, WorkflowEdge[]>();
  readonly allIn = new Map<string, WorkflowEdge[]>();
  readonly loopById = new Map<string, CompiledLoop>();
  readonly outputs = new Map<string, NodeOutput>();
  readonly latest = new Map<string, { status: DecisionStatus; evaluationId: string | null }>();
  readonly nodeStatus = new Map<string, NodeRuntimeStatus>();
  readonly failures: FailureRecord[] = [];
  readonly approvals = new Map<string, PendingApproval>();
  readonly inflightSessions = new Map<string, string>();
  readonly abort = new AbortController();
  readonly semaphore: Semaphore;
  executionCount = 0;
  fatal: RunFatal | null = null;
  deadlineTimer: NodeJS.Timeout | null = null;

  constructor(
    public run: RunRecord,
    readonly graph: CompiledGraph,
    readonly active: Set<string>,
    readonly startNodeIds: Set<string>,
    readonly options: {
      inputOverride: string | null;
      inputStartNodeIds: Set<string>;
      scope: string | null;
      boundaryEdgeIds: Set<string>;
      clearStartNodeIds: Set<string>;
      workflowName: string;
      workspace: string;
    },
    readonly deps: RunDeps,
  ) {
    this.semaphore = new Semaphore(Math.max(1, run.maxConcurrency));
    for (const node of graph.nodes) {
      this.nodeById.set(node.id, node);
      this.forwardOut.set(node.id, []);
      this.forwardIn.set(node.id, []);
      this.allIn.set(node.id, []);
    }
    for (const edge of graph.edges) {
      this.allIn.get(edge.target)!.push(edge);
      if (edge.data.orchestration.feedback) continue;
      this.forwardOut.get(edge.source)!.push(edge);
      this.forwardIn.get(edge.target)!.push(edge);
    }
    for (const loop of graph.loops) this.loopById.set(loop.id, loop);
    for (const id of active) this.nodeStatus.set(id, 'queued');
  }

  get runId(): string {
    return this.run.id;
  }

  rootPath(): IterationPath {
    return { scope: this.options.scope, steps: [] };
  }

  executionId(nodeId: string, path: IterationPath): string {
    const scope = path.scope ? `@${path.scope}` : '';
    const steps = path.steps.length ? `@${path.steps.map((step) => `${step.loopId}:${step.iteration}`).join('/')}` : '';
    return `${nodeId}${scope}${steps}`;
  }

  remainingMs(): number | null {
    return this.run.deadlineAt === null ? null : this.run.deadlineAt - this.deps.now();
  }

  checkFatal(): void {
    if (this.fatal) throw this.fatal;
  }
}

export function pathHasPrefix(path: IterationPath, prefix: IterationPath): boolean {
  if (prefix.steps.length > path.steps.length) return false;
  return prefix.steps.every((step, index) => path.steps[index].loopId === step.loopId && path.steps[index].iteration === step.iteration);
}
