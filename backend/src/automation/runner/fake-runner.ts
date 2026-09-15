/**
 * 确定性的假 Runner：测试与本机演示用（`CLAWOPT_WORKFLOW_FAKE_RUNNER=1`）。
 * 不起任何进程、不连网关，只按节点任务里的指令行给出结果：
 *
 *   [fake:delay 1500]            先等 1.5 秒（可被中止）
 *   [fake:fail 原因]              本轮失败
 *   [fake:seq a|b|c]              第 n 次调用（按任务文本计数）输出第 n 项，超出取最后一项
 *   [fake:output 文本]            固定输出
 *
 * 没有指令时输出 `ok: <任务前 80 字>`。
 */
import type { AgentRunRequest, AgentRunResult, WorkflowAgentRunner } from '../ports';
import { delay } from '../shared/util';

export type ScriptedHandler = (req: AgentRunRequest, callIndex: number) => AgentRunResult | Promise<AgentRunResult>;

/** 测试用：把行为交给回调，自己只负责计数、超时与中止语义。 */
export function createScriptedRunner(handler: ScriptedHandler): WorkflowAgentRunner & { calls: AgentRunRequest[]; aborted: string[]; discarded: string[] } {
  const calls: AgentRunRequest[] = [];
  const aborted: string[] = [];
  const discarded: string[] = [];
  return {
    calls,
    aborted,
    discarded,
    async runAndWait(req) {
      calls.push(req);
      const index = calls.length - 1;
      if (req.signal.aborted) return { ok: false, output: '', error: 'aborted', sessionId: req.sessionId };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<AgentRunResult>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, output: '', error: 'timeout', timedOut: true, sessionId: req.sessionId }), req.timeoutMs);
      });
      let onAbort: (() => void) | undefined;
      const abortedResult = new Promise<AgentRunResult>((resolve) => {
        onAbort = () => resolve({ ok: false, output: '', error: 'aborted', sessionId: req.sessionId });
        req.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([Promise.resolve(handler(req, index)), timeout, abortedResult]);
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) req.signal.removeEventListener('abort', onAbort);
      }
    },
    abort(sessionId) {
      aborted.push(sessionId);
    },
    discardSessions(sessionIds) {
      discarded.push(...sessionIds);
    },
  };
}

export function currentTaskOf(req: AgentRunRequest): string {
  const text = req.input.find((block) => block.type === 'text');
  const content = text && text.type === 'text' ? text.text : '';
  const marker = content.lastIndexOf('[Current task]\n');
  return marker >= 0 ? content.slice(marker + '[Current task]\n'.length) : content;
}

export function createFakeRunner(): WorkflowAgentRunner {
  const counters = new Map<string, number>();
  return createScriptedRunner(async (req) => {
    const task = currentTaskOf(req);
    const count = counters.get(task) ?? 0;
    counters.set(task, count + 1);
    const delayMatch = /\[fake:delay (\d+)\]/.exec(task);
    if (delayMatch) {
      try {
        await delay(Math.min(Number(delayMatch[1]), 600_000), req.signal);
      } catch {
        return { ok: false, output: '', error: 'aborted', sessionId: req.sessionId };
      }
    }
    const fail = /\[fake:fail ?([^\]]*)\]/.exec(task);
    if (fail) return { ok: false, output: '', error: fail[1] || 'fake failure', sessionId: req.sessionId };
    const seq = /\[fake:seq ([^\]]*)\]/.exec(task);
    if (seq) {
      const items = seq[1].split('|');
      return { ok: true, output: items[Math.min(count, items.length - 1)], sessionId: req.sessionId };
    }
    const fixed = /\[fake:output ([^\]]*)\]/.exec(task);
    if (fixed) return { ok: true, output: fixed[1], sessionId: req.sessionId };
    return { ok: true, output: `ok: ${task.replace(/\s+/g, ' ').slice(0, 80)}`, sessionId: req.sessionId };
  });
}
