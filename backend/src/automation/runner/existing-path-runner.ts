/**
 * ★ 接缝：`WorkflowAgentRunner` 的临时实现，走 ClawOPT **已有**的两条执行路径。
 *
 * 运行协调器（`runtime/coordinator`）落地后，用它的 run-and-wait 替换本文件，并改 `automation/index.ts`
 * 里 `createAutomation` 的一行装配。引擎、看板、测试都不需要改。本文件刻意保持薄：
 * 不做队列、不做续传、不落聊天消息表——那些是协调器的职责，在这里补一半只会和协调器分家。
 *
 * - **OpenClaw**：网关 `chat.send`（会话键 `agent:<id>:workflow:<sessionId>`，与用户单聊互不干扰）
 *   → `agent.wait` → `chat.history` 取最后一条助手文本。中止走 `chat.abort`。
 *   工具权限询问由 OpenClaw 自己的执行审批配置决定；`autoApprove` 在这条路上**没有**对应开关（TODO：协调器）。
 * - **外部运行时**：本机执行器 + 适配器（目前只有 claude-code 有适配器）。
 *   Claude Code headless 用 `--permission-prompts none`，即对需要询问的工具一律拒绝——相当于 `autoApprove: 'deny'`；
 *   `'once'` 在今天的适配器里表达不出来（TODO：协调器）。
 */
import fs from 'fs';

import { assertRegularFile, type GatewayConnections } from '../../openclaw';
import { ClaudeCodeAdapter, runExternalAgent, type ExternalAgentAdapter } from '../../runtime';
import type { AgentRunRequest, AgentRunResult, ContentBlocks, WorkflowAgentRunner } from '../ports';

const EXTERNAL_ADAPTERS: Record<string, () => ExternalAgentAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
};

export const supportedExternalRuntimes = () => Object.keys(EXTERNAL_ADAPTERS);

function blocksToText(blocks: ContentBlocks): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else parts.push(`[Attached ${block.type}: ${block.name}] ${block.path}`);
  }
  return parts.join('\n\n');
}

export function createExistingPathRunner(deps: { gatewayConnections: GatewayConnections }): WorkflowAgentRunner {
  const openclawSessions = new Map<string, { sessionKey: string; runId?: string; connectionKey: string }>();
  const externalControllers = new Map<string, AbortController>();

  async function runOpenClaw(req: AgentRunRequest): Promise<AgentRunResult> {
    const connectionKey = `workflow:${req.sessionId}`;
    const sessionKey = `agent:${req.agentRef.id}:workflow:${req.sessionId}`;
    openclawSessions.set(req.sessionId, { sessionKey, connectionKey });
    const started = Date.now();
    try {
      const client = await deps.gatewayConnections.getConnection(connectionKey);
      const attachments = req.input
        .filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
        .map((block) => {
          // 路径已过可服务路径闸门（realpath 在上传目录 / 工作区内）；这里再拒绝非普通文件，防命名管道挂住读取。
          assertRegularFile(block.path);
          return { type: 'image', mimeType: block.mediaType, content: fs.readFileSync(block.path).toString('base64') };
        });
      const message = blocksToText(req.input.filter((block) => block.type !== 'image'));
      const { runId } = await client.sendChatMessageStreaming({ sessionKey, message, agentId: req.agentRef.id, attachments });
      openclawSessions.set(req.sessionId, { sessionKey, runId, connectionKey });
      const aborted = new Promise<never>((_, reject) => {
        if (req.signal.aborted) reject(new Error('aborted'));
        req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      await Promise.race([client.waitForRun(runId, Math.max(1_000, req.timeoutMs)), aborted]);
      const output = await client.getLatestAssistantText(sessionKey, 20);
      if (!output.trim()) return { ok: false, output: '', error: 'no assistant text returned', sessionId: req.sessionId };
      return { ok: true, output, sessionId: req.sessionId };
    } catch (error) {
      const message = (error as Error)?.message || String(error);
      const timedOut = Date.now() - started >= req.timeoutMs - 50;
      return { ok: false, output: '', error: timedOut ? 'timeout' : message.slice(0, 2000), timedOut, sessionId: req.sessionId };
    } finally {
      openclawSessions.delete(req.sessionId);
      deps.gatewayConnections.disconnectConnection(connectionKey);
    }
  }

  async function runExternal(req: AgentRunRequest): Promise<AgentRunResult> {
    const runtime = req.agentRef.runtime ?? req.agentRef.id;
    const makeAdapter = EXTERNAL_ADAPTERS[runtime];
    if (!makeAdapter) return { ok: false, output: '', error: `runtime ${runtime} has no adapter`, sessionId: req.sessionId };
    const adapter = makeAdapter();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });
    externalControllers.set(req.sessionId, controller);
    try {
      const built = adapter.buildCommand({
        sessionId: req.sessionId,
        prompt: blocksToText(req.input),
        workingDir: req.workspace,
        resume: false,
        ...(req.model ? { model: req.model } : {}),
      });
      const result = await runExternalAgent(built, adapter, { onEvent: () => undefined, timeoutMs: req.timeoutMs, signal: controller.signal });
      return {
        ok: result.ok,
        output: result.finalText ?? '',
        ...(result.ok ? {} : { error: result.errorDetail ?? 'external agent failed' }),
        timedOut: result.timedOut,
        sessionId: req.sessionId,
      };
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      externalControllers.delete(req.sessionId);
    }
  }

  return {
    runAndWait(req) {
      return req.agentRef.kind === 'openclaw' ? runOpenClaw(req) : runExternal(req);
    },
    async abort(sessionId) {
      externalControllers.get(sessionId)?.abort();
      const openclaw = openclawSessions.get(sessionId);
      if (!openclaw) return;
      try {
        const client = await deps.gatewayConnections.getConnection(openclaw.connectionKey);
        await client.abortChat({ sessionKey: openclaw.sessionKey, ...(openclaw.runId ? { runId: openclaw.runId } : {}), timeoutMs: 5_000 });
      } catch {
        // 中止是尽力而为
      }
    },
  };
}
