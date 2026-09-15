/**
 * 工具调用的原子落库分组。
 *
 * 不变量：库里**永远不会出现「有调用、没结果」**的工具调用。那种状态下次拼上下文时
 * 会让模型服务商直接拒绝请求（assistant 引用了一个不存在的 tool result），而且是在下一轮才炸。
 *
 * 分组规则：
 * - 一组从第一个调用开始；
 * - 组里还没有任何结果时，新来的调用并入这一组（并行调用）；
 * - 组里已经出现过结果之后，新来的调用另开一组（顺序调用）；
 * - 一组的**每个**调用都有结果了，整组一次性交给落库回调（在一个事务里写）；
 * - 运行结束时还没凑齐的组，缺结果的调用补一条 `interrupted` 失败结果再落库。
 *
 * 同一个 call_id 在同一次运行里只算一次（CLI 会每轮复用 `item_2` 这类 id，所以键带 run marker）。
 */

export interface ToolCallRecord {
  callId: string;
  name: string;
  arguments: string;
  output: string | null;
  status: 'completed' | 'failed' | 'interrupted' | null;
  startedAt: number;
  completedAt: number | null;
}

export const INTERRUPTED_TOOL_OUTPUT = '[interrupted: the run ended before this tool returned]';

type Group = { calls: Map<string, ToolCallRecord>; sawOutput: boolean };

export class ToolCallGroups {
  private groups: Group[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly persist: (calls: ToolCallRecord[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** 返回 false 表示这个调用已经登记过（重复事件）。 */
  addCall(callId: string, name: string, args: string): boolean {
    if (this.seen.has(callId)) return false;
    this.seen.add(callId);
    let group = this.groups[this.groups.length - 1];
    if (!group || group.sawOutput) {
      group = { calls: new Map(), sawOutput: false };
      this.groups.push(group);
    }
    group.calls.set(callId, { callId, name, arguments: args, output: null, status: null, startedAt: this.now(), completedAt: null });
    return true;
  }

  updateArguments(callId: string, args: string): void {
    for (const group of this.groups) {
      const call = group.calls.get(callId);
      if (call && call.output === null) call.arguments = args;
    }
  }

  /**
   * 返回 false 表示这个调用已经有结果（重复事件）。
   *
   * 没见过开始事件的结果（订阅晚了一步、网关只推了 result）不丢：
   * 就地补一条调用记录、单独成组写入——库里依旧没有「有调用没结果」的行。
   */
  addOutput(callId: string, output: string, status: 'completed' | 'failed', missed?: { name?: string; arguments?: string }): boolean {
    const index = this.groups.findIndex((group) => group.calls.has(callId));
    if (index < 0) {
      if (this.seen.has(callId)) return false;
      this.seen.add(callId);
      const now = this.now();
      this.persist([{ callId, name: missed?.name ?? 'tool', arguments: missed?.arguments ?? '', output, status, startedAt: now, completedAt: now }]);
      return true;
    }
    const group = this.groups[index];
    const call = group.calls.get(callId)!;
    if (call.output !== null) return false;
    call.output = output;
    call.status = status;
    call.completedAt = this.now();
    group.sawOutput = true;
    if ([...group.calls.values()].every((item) => item.output !== null)) {
      this.groups.splice(index, 1);
      this.persist([...group.calls.values()]);
    }
    return true;
  }

  /** 运行结束：没凑齐的组补上 interrupted 结果后落库。返回补了几条。 */
  flush(): number {
    let synthesized = 0;
    for (const group of this.groups) {
      for (const call of group.calls.values()) {
        if (call.output !== null) continue;
        call.output = INTERRUPTED_TOOL_OUTPUT;
        call.status = 'interrupted';
        call.completedAt = this.now();
        synthesized += 1;
      }
      this.persist([...group.calls.values()]);
    }
    this.groups = [];
    return synthesized;
  }

  get openCallCount(): number {
    return this.groups.reduce((sum, group) => sum + [...group.calls.values()].filter((call) => call.output === null).length, 0);
  }
}
