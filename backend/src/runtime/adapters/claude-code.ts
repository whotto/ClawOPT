/**
 * Claude Code 运行时适配器（契约版）。
 *
 * 命令怎么构造、stream-json 怎么逐行解析，仍在 `external-agents/claude-code.ts`（实测契约都在那里）；
 * 这里只把解析出来的事件**翻译成规范事件**，并把执行器（`external-agents/executor.ts`）
 * 包成 `AdapterRunHandle`。执行器由工厂注入：本机子进程与将来的远程 relay 是同一个接口。
 *
 * 翻译规则（与 spec 04 §3.1 对齐，只用当前命令行已经产出的事件——`--include-partial-messages`
 * 不在现有命令里，不为了翻译去改变真机上验过的命令）：
 * - `system/init` → `runtime.init` + `runtime.native_session`；
 * - `assistant` 消息的 text 块 → message item + `output_text.delta`（按消息 id 归组）；
 * - `assistant` 消息的 tool_use 块 → function_call added/done；
 * - `user` 消息的 tool_result 块 → function_call_output（is_error → failed）；
 * - `result` → 整轮用量（scope=run，call id = `claude-code:<会话>:<result uuid>`）+ completed/failed。
 *
 * 不走代理（global 模式，用 CLI 自己的登录）：事实来源全部是 native。
 */
import {
  defineCapabilities,
  defineSourceOfTruth,
  type AdapterRunContext,
  type AdapterRunHandle,
  type AdapterRunOutcome,
  type AgentRuntimeAdapter,
  type CanonicalEvent,
  type InterruptReason,
  type UsageReport,
} from '../contract';
import { ClaudeCodeAdapter } from '../external-agents/claude-code';
import { runExternalAgent, type RunResult } from '../external-agents/executor';
import type { BuiltCommand, ExternalAgentAdapter, ExternalRunEvent, ExternalRunRequest } from '../external-agents/types';

/** 执行器签名：本机子进程（runExternalAgent）或任何实现了同一签名的远程执行器。 */
export type CommandExecutor = (
  built: BuiltCommand,
  parser: ExternalAgentAdapter,
  options: { onEvent: (event: ExternalRunEvent) => void; signal?: AbortSignal; timeoutMs?: number },
) => Promise<RunResult>;

export const CLAUDE_CODE_CAPABILITIES = defineCapabilities({
  boundaryInterrupt: false,
  nativeResume: true,
  // headless 下 `--permission-prompts none`：会弹窗的一律拒绝，没有交互式审批。
  approvals: false,
  clarify: false,
  hostCompression: false,
  nativeCompact: true,
  backgroundDelegation: false,
  images: false,
  mcpInjection: false,
  proxyMode: ['global'],
});

export const CLAUDE_CODE_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** 一次运行内的翻译状态。 */
class ClaudeStreamTranslator {
  private messageSeq = 0;
  private readonly openedMessages = new Set<string>();
  private readonly seenToolUses = new Set<string>();
  private readonly seenToolResults = new Set<string>();
  private model: string | undefined;
  private lastMessageId: string | null = null;
  text = '';

  constructor(private readonly runId: string, private readonly emit: (event: CanonicalEvent) => void) {}

  private messageId(raw: any): string {
    const id = typeof raw?.message?.id === 'string' ? raw.message.id : null;
    if (id) return id;
    // 没有原始事件（测试替身、老版本 CLI）时，同一轮里连续的正文并到同一个 item。
    return this.lastMessageId ?? `msg_${this.runId}_${this.messageSeq++}`;
  }

  handle(event: ExternalRunEvent): void {
    const raw: any = event.raw;
    if (event.sessionId) this.emit({ type: 'runtime.native_session', nativeSessionId: event.sessionId });

    if (event.kind === 'init') {
      this.model = event.model;
      this.emit({ type: 'runtime.init', model: event.model, runtimeVersion: event.runtimeVersion });
      return;
    }

    if ((event.kind === 'delta' || event.kind === 'progress') && (raw?.type === 'assistant' || raw === undefined)) {
      const blocks: any[] = Array.isArray(raw?.message?.content) ? raw.message.content : [];
      if (event.kind === 'delta' && event.text) {
        const itemId = this.messageId(raw);
        this.lastMessageId = itemId;
        if (!this.openedMessages.has(itemId)) {
          this.openedMessages.add(itemId);
          this.emit({ type: 'response.output_item.added', item: { type: 'message', id: itemId, role: 'assistant' } });
        }
        this.text += event.text;
        this.emit({ type: 'response.output_text.delta', item_id: itemId, delta: event.text });
      }
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || this.seenToolUses.has(block.id)) continue;
        this.seenToolUses.add(block.id);
        const args = (() => {
          try { return JSON.stringify(block.input ?? {}); } catch { return '{}'; }
        })();
        const item = { type: 'function_call' as const, id: block.id, call_id: block.id, name: String(block.name ?? 'tool'), arguments: args };
        this.emit({ type: 'response.output_item.added', item });
        this.emit({ type: 'response.output_item.done', item });
      }
      return;
    }

    if (event.kind === 'unknown' && raw?.type === 'user') {
      const blocks: any[] = Array.isArray(raw?.message?.content) ? raw.message.content : [];
      for (const block of blocks) {
        const callId = block?.tool_use_id;
        if (block?.type !== 'tool_result' || typeof callId !== 'string' || this.seenToolResults.has(callId)) continue;
        this.seenToolResults.add(callId);
        this.emit({
          type: 'response.output_item.done',
          item: {
            type: 'function_call_output',
            id: `out_${callId}`,
            call_id: callId,
            output: flattenToolResult(block.content),
            status: block.is_error === true ? 'failed' : 'completed',
          },
        });
      }
      return;
    }

    if (event.kind === 'final' || event.kind === 'error') {
      const usage = this.usageFrom(raw, event);
      if (usage) this.emit({ type: 'usage.reported', usage });
      const responseId = this.lastMessageId ?? `resp_${this.runId}`;
      if (event.kind === 'final') {
        this.emit({ type: 'response.completed', response_id: responseId, output_text: event.text ?? this.text });
      } else {
        this.emit({ type: 'response.failed', response_id: responseId, error: { message: event.detail ?? 'error' } });
      }
    }
  }

  /** 整轮用量。CLI 只在 result 里给出可信的合计；逐消息拆分留给 P2。 */
  private usageFrom(raw: any, event: ExternalRunEvent): UsageReport | null {
    const usage = raw?.usage;
    if (!usage || typeof usage !== 'object') return null;
    const sessionId = event.sessionId ?? raw?.session_id ?? 'unknown-session';
    const resultId = typeof raw?.uuid === 'string' ? raw.uuid : this.runId;
    const models = raw?.modelUsage && typeof raw.modelUsage === 'object' ? Object.keys(raw.modelUsage) : [];
    return {
      callId: `claude-code:${sessionId}:${resultId}`,
      scope: 'run',
      model: models.length === 1 ? models[0] : this.model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
      reasoningTokens: 0,
      apiCalls: Math.max(1, num(raw?.num_turns)),
      costUsd: typeof event.costUsd === 'number' ? event.costUsd : undefined,
    };
  }
}

export function createClaudeCodeRuntimeAdapter(options: { executor?: CommandExecutor } = {}): AgentRuntimeAdapter<ExternalRunRequest> {
  const executor: CommandExecutor = options.executor ?? runExternalAgent;
  const commands = new ClaudeCodeAdapter();

  return {
    id: commands.runtime,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    sourceOfTruth: CLAUDE_CODE_SOURCE_OF_TRUTH,
    start(context: AdapterRunContext<ExternalRunRequest>): AdapterRunHandle {
      const translator = new ClaudeStreamTranslator(context.runId, (event) => context.emit({ channel: 'native', event }));
      let finished = false;
      let interruptReason: InterruptReason | null = null;
      const built = commands.buildCommand(context.request);

      const done: Promise<AdapterRunOutcome> = executor(built, commands, {
        signal: context.signal,
        onEvent: (event) => translator.handle(event),
      }).then((result): AdapterRunOutcome => {
        if (result.aborted) {
          return { kind: 'aborted', reason: interruptReason ?? 'user_stop', synced: true, phase: 'running' };
        }
        if (result.ok) return { kind: 'completed', outputText: result.finalText ?? translator.text };
        return {
          kind: 'failed',
          error: result.errorDetail || 'unknown',
          stopReason: result.timedOut ? 'hard_timeout' : undefined,
        };
      }, (error): AdapterRunOutcome => ({ kind: 'failed', error: (error as Error)?.message || String(error) }))
        .finally(() => { finished = true; });

      return {
        done,
        status: () => ({ phase: finished ? 'finished' : 'running', nativeRunId: context.request.sessionId }),
        // 协调器中止时已经触发了 signal，执行器据此先 SIGTERM 整个进程组、宽限后 SIGKILL；
        // 这里只记下原因，等进程真的关掉（close）再确认。
        interrupt: async (reason) => {
          interruptReason = reason;
          await done;
          return { synced: true };
        },
      };
    },
  };
}
