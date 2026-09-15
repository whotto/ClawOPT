/**
 * `WorkflowAgentRunner` 的正式实现：工作流节点与看板派活都作为**真实的协调器会话**运行。
 *
 * 替换了 P4a 的临时 Runner（直接调网关 / 执行器）。现在：
 * - 每次 `runAndWait` 向运行协调器提交一轮，会话键 `workflow:<sessionId>`、表面 `workflow`：
 *   会话行、run marker、中止宽限、工具调用原子落库、用量去重、终态顺序、业务事件（`chat.run.*` 等，
 *   Webhook 据此外发）都由协调器负责——和单聊、群聊外部成员是同一套。
 * - 表面 `workflow` 不建单聊会话、不进群，所以不出现在任何聊天列表里；转录（提示词、工具调用、用量、输出）
 *   由工作流运行面板按会话键读，运行中的增量走 `/ws` 的 `session:workflow:<sessionId>` 主题。
 * - 适配器只翻译：OpenClaw 用网关单聊适配器（会话键 `agent:<id>:workflow:<sessionId>`，与用户单聊互不干扰，
 *   专用网关连接 `workflow:<sessionId>`，结束即断开）；外部运行时用各自的契约适配器（目前 claude-code）。
 * - 审批：提交时带 `autoApprove`，协调器在请求排到队首时自动答「允许一次」/ 拒绝。**今天两个适配器都不发审批请求**：
 *   OpenClaw 的执行审批由网关自己的配置决定；Claude Code headless 用 `--permission-prompts none`（需要询问的工具一律拒绝）。
 *   将来声明了 `approvals` 能力的运行时自动生效，不用改这里。
 * - 运行被删：`discardSessions` 删协调器会话行与工具调用（用量保留）。
 * - 超时：Runner 自己计时，到点经协调器中止（外部运行时同时把剩余时限交给执行器做硬超时）。
 */
import fs from 'fs';

import { assertRegularFile, type GatewayConnections, type OpenClawClient } from '../../openclaw';
import {
  createClaudeCodeRuntimeAdapter,
  type AgentRuntimeAdapter,
  type ExternalRunRequest,
  type OpenClawChatRunRequest,
  type RunCoordinator,
  type RunTerminal,
} from '../../runtime';
import type { AgentRunRequest, AgentRunResult, ContentBlocks, WorkflowAgentRunner } from '../ports';

/** 协调器会话键。转录接口、`/ws` 主题、资源授权都按它找会话。 */
export function workflowSessionKey(sessionId: string): string {
  return `workflow:${sessionId}`;
}

/** 协调器会话里的 Agent id：OpenClaw 用角色 id；外部运行时没有角色，用 `ext:<运行时>:workflow`。授权按它判。 */
export function workflowAgentId(ref: { kind: string; id: string; runtime?: string }): string {
  return ref.kind === 'openclaw' ? ref.id : `ext:${ref.runtime ?? ref.id}:workflow`;
}

type ExternalAdapterFactory = () => AgentRuntimeAdapter<ExternalRunRequest>;

const DEFAULT_EXTERNAL_ADAPTERS: Record<string, ExternalAdapterFactory> = {
  'claude-code': () => createClaudeCodeRuntimeAdapter(),
};

export const supportedExternalRuntimes = () => Object.keys(DEFAULT_EXTERNAL_ADAPTERS);

function blocksToText(blocks: ContentBlocks): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else parts.push(`[Attached ${block.type}: ${block.name}] ${block.path}`);
  }
  return parts.join('\n\n');
}

export type CoordinatorRunnerDeps = {
  runCoordinator: Pick<RunCoordinator, 'submit' | 'abort'>;
  openclawAdapter: AgentRuntimeAdapter<OpenClawChatRunRequest>;
  gatewayConnections: Pick<GatewayConnections, 'getConnection' | 'disconnectConnection'>;
  connections: Map<string, OpenClawClient>;
  /** 协调器通用表的删除口（运行被删时清会话行与工具调用）。 */
  db: { deleteRunSessionData(sessionKey: string): void };
  /** 测试注入；缺省 = 各运行时的契约适配器。 */
  externalAdapters?: Record<string, ExternalAdapterFactory>;
};

export function createCoordinatorRunner(deps: CoordinatorRunnerDeps): WorkflowAgentRunner {
  const externalAdapters = deps.externalAdapters ?? DEFAULT_EXTERNAL_ADAPTERS;

  function openclawRequest(req: AgentRunRequest, connectionKey: string): OpenClawChatRunRequest {
    return {
      sessionId: `agent:${req.agentRef.id}:workflow:${req.sessionId}`,
      agentId: req.agentRef.id,
      getConnection: () => deps.gatewayConnections.getConnection(connectionKey),
      prepareMessage: async () => ({
        text: blocksToText(req.input.filter((block) => block.type !== 'image')),
        attachments: req.input
          .filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
          .map((block) => {
            // 路径已过可服务路径闸门（realpath 在上传目录 / 工作区内）；这里再拒绝非普通文件，防命名管道挂住读取。
            assertRegularFile(block.path);
            return { type: 'image', mimeType: block.mediaType, content: fs.readFileSync(block.path).toString('base64') };
          }),
      }),
      onGatewayReconnected: (client) => { deps.connections.set(connectionKey, client as OpenClawClient); },
    };
  }

  function toResult(req: AgentRunRequest, terminal: RunTerminal, timedOut: boolean): AgentRunResult {
    const { outcome } = terminal;
    const base = { sessionId: req.sessionId };
    if (outcome.kind === 'completed') {
      const output = terminal.projection.output ?? outcome.outputText ?? '';
      if (!output.trim()) return { ...base, ok: false, output: '', error: 'no assistant text returned' };
      return { ...base, ok: true, output };
    }
    if (outcome.kind === 'failed') {
      const hardTimeout = timedOut || outcome.stopReason === 'hard_timeout';
      return { ...base, ok: false, output: '', error: hardTimeout ? 'timeout' : outcome.error.slice(0, 2000), timedOut: hardTimeout };
    }
    return { ...base, ok: false, output: '', error: timedOut ? 'timeout' : 'aborted', timedOut };
  }

  async function runAndWait(req: AgentRunRequest): Promise<AgentRunResult> {
    if (req.signal.aborted) return { ok: false, output: '', error: 'aborted', sessionId: req.sessionId };
    const sessionKey = workflowSessionKey(req.sessionId);
    const isOpenClaw = req.agentRef.kind === 'openclaw';
    const runtime = req.agentRef.runtime ?? req.agentRef.id;
    const connectionKey = `workflow:${req.sessionId}`;

    let adapter: AgentRuntimeAdapter<any>;
    let request: OpenClawChatRunRequest | ExternalRunRequest;
    if (isOpenClaw) {
      adapter = deps.openclawAdapter;
      request = openclawRequest(req, connectionKey);
    } else {
      const makeAdapter = externalAdapters[runtime];
      if (!makeAdapter) return { ok: false, output: '', error: `runtime ${runtime} has no adapter`, sessionId: req.sessionId };
      adapter = makeAdapter();
      request = {
        sessionId: req.sessionId,
        prompt: blocksToText(req.input),
        workingDir: req.workspace,
        resume: false,
        timeoutMs: req.timeoutMs,
        ...(req.model ? { model: req.model } : {}),
      };
    }

    let timedOut = false;
    const stop = () => { void deps.runCoordinator.abort(sessionKey, 'user_stop').catch(() => undefined); };
    const onAbort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1_000, req.timeoutMs));
    timer.unref?.();
    try {
      const submitted = await deps.runCoordinator.submit({
        sessionKey,
        surface: 'workflow',
        topics: [`session:${sessionKey}`],
        agentId: workflowAgentId(req.agentRef),
        title: 'workflow',
        adapter,
        request,
        projector: () => ({
          // 工作流节点没有自己的消息行：转录读协调器的通用表，运行中的增量协调器已经发进会话主题。
          onEvent: () => {},
          finish: (outcome) => ({
            output: outcome.kind === 'completed' ? outcome.outputText ?? '' : undefined,
            error: outcome.kind === 'failed' ? outcome.error : undefined,
          }),
        }),
        workspacePath: isOpenClaw ? undefined : req.workspace,
        display: null,
        meta: { kind: 'workflow-node', sessionId: req.sessionId },
        autoApprove: req.autoApprove,
      }, 'reject');
      if (submitted.status !== 'started') {
        return { ok: false, output: '', error: 'workflow session is busy', sessionId: req.sessionId };
      }
      req.signal.addEventListener('abort', onAbort, { once: true });
      // 提交与挂监听之间被停：补一次中止。
      if (req.signal.aborted) stop();
      const terminal = await submitted.completion;
      return toResult(req, terminal, timedOut);
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
      if (isOpenClaw) deps.gatewayConnections.disconnectConnection(connectionKey);
    }
  }

  return {
    runAndWait,
    async abort(sessionId) {
      await deps.runCoordinator.abort(workflowSessionKey(sessionId), 'user_stop');
    },
    discardSessions(sessionIds) {
      for (const sessionId of sessionIds) deps.db.deleteRunSessionData(workflowSessionKey(sessionId));
    },
  };
}
