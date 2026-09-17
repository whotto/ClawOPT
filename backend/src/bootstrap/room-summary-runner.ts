/**
 * 群摘要模型的执行（P3）。放在 bootstrap：它把 runtime（本地模型代理）、automation（Agent 运行器）、control（模型配置）
 * 接给 collab/rooms，几个模块彼此不直接依赖。
 *
 * 摘要模型的取值（房间设置里选）：
 * - `provider:<端点>/<模型>`：ClawOPT 模型配置里的模型，**经 P2 本地模型代理**调用——上游 key 只进代理内存，
 *   这里拿到的是每目标令牌；按 Responses 协议非流式调用，代理负责翻译成上游协议（Chat Completions / Anthropic / Responses）。
 * - `agent:openclaw:<Agent>`：OpenClaw Agent；`agent:<运行时>`：本机外部运行时（global 模式，用它自己的登录）。
 *   都经自动化模块的 Agent 运行器（协调器里 `workflow` 表面的一轮，审批一律拒绝，无人值守）。
 */
import { randomUUID } from 'crypto';

import type { WorkflowAgentRunner } from '../automation';
import { ensureGroupWorkspace, type SummaryModelRunner } from '../collab/rooms';
import type { ProviderProxy, ScopedProviderResolver } from '../runtime';

export const SUMMARY_RUN_TIMEOUT_MS = 180_000;

/** Responses 非流式响应里的输出文本。 */
export function extractResponsesText(json: any): string {
  if (typeof json?.output_text === 'string') return json.output_text;
  const parts: string[] = [];
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (item?.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('');
}

export function createRoomSummaryRunner(deps: {
  proxy: ProviderProxy;
  resolveScopedProvider: ScopedProviderResolver;
  agentRunner: () => WorkflowAgentRunner;
  fetchImpl?: typeof fetch;
}): SummaryModelRunner {
  return async ({ groupId, model, system, user, signal }) => {
    const spec = model.trim();
    if (spec.startsWith('provider:')) {
      const provider = deps.resolveScopedProvider({ model: spec.slice('provider:'.length) }, 'room-summary');
      if (!provider) throw new Error('summary model is not configured');
      const target = deps.proxy.register({ ...provider, runtime: 'room-summary', runId: randomUUID(), sessionId: `room-summary:${groupId}` });
      const timeout = AbortSignal.timeout(SUMMARY_RUN_TIMEOUT_MS);
      try {
        // 代理地址是本进程自己（回环），不是用户给的 URL：不经出站地址策略；上游地址的策略在代理里。
        const response = await (deps.fetchImpl ?? fetch)(`${target.responsesBaseUrl}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
          body: JSON.stringify({ model: provider.model, instructions: system, input: user, stream: false }),
          signal: AbortSignal.any([signal, timeout]),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`summary model request failed (HTTP ${response.status})`);
        return extractResponsesText(JSON.parse(text));
      } finally {
        target.revoke();
      }
    }
    if (spec.startsWith('agent:')) {
      const rest = spec.slice('agent:'.length);
      const agentRef = rest.startsWith('openclaw:')
        ? { kind: 'openclaw' as const, id: rest.slice('openclaw:'.length) }
        : { kind: 'external' as const, id: rest, runtime: rest, mode: 'global' as const };
      const result = await deps.agentRunner().runAndWait({
        sessionId: `room-summary-${randomUUID()}`,
        agentRef,
        input: [{ type: 'text', text: `${system}\n\n${user}` }],
        workspace: ensureGroupWorkspace(groupId).workspacePath,
        timeoutMs: SUMMARY_RUN_TIMEOUT_MS,
        autoApprove: 'deny',
        signal,
      });
      if (!result.ok) throw new Error(result.error || 'summary agent run failed');
      return result.output;
    }
    throw new Error(`unsupported summary model: ${spec.slice(0, 80)}`);
  };
}
