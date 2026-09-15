/**
 * P1b 上下文占用徽标与原生压缩：占用按最近一次模型调用（含缓存）、窗口按模型配置、`/compact` 走网关 `sessions.compact`、
 * `/usage` 结构化结果、超长错误翻成可操作的 `chat.contextWindowTooSmall`。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compactCommandResult, computeContextUsage, isContextWindowTooSmallError, resolveContextWindow, usageCommandResult,
} from '../src/collab/sessions/context-usage';
import { createStructuredChatError } from '../src/collab/sessions/chat-messages';
import { FakeGatewayClient } from './helpers/fake-gateway';
import { pinFakeGateway, readSse, startAppHarness, type AppHarness } from './helpers/app-harness';

const row = (over: Record<string, unknown> = {}) => ({
  id: 1, session_key: 's', run_id: 'r', source: 'openclaw', agent_id: 'main', usage_scope: 'model_call', purpose: null, model: 'm', provider: 'p', api_calls: 1,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: null, created_at: '2026-09-15', ...over,
}) as any;

describe('上下文占用', () => {
  it('取最近一次模型调用：输入 + 缓存读 + 缓存写 + 输出；百分比按窗口；整轮合计行只在没有逐次调用时才用并标近似', () => {
    const usage = computeContextUsage([
      row({ input_tokens: 50_000 }),
      row({ id: 2, input_tokens: 100, cache_read_tokens: 20_000, cache_write_tokens: 5_000, output_tokens: 900 }),
      row({ id: 3, usage_scope: 'run', input_tokens: 999_999 }),
    ], 200_000);
    expect(usage).toMatchObject({ usedTokens: 26_000, contextWindow: 200_000, percent: 13, approximate: false });
    expect(computeContextUsage([row({ usage_scope: 'run', input_tokens: 10 })], null)).toMatchObject({ usedTokens: 10, approximate: true, percent: null });
    expect(computeContextUsage([], 1000)).toMatchObject({ usedTokens: null });
  });

  it('窗口：模型级覆盖提供方级，contextTokens 兜底；不认识的 ref 为 null', () => {
    const config = { models: { providers: { deepseek: { contextWindow: 64_000, models: [{ id: 'v4', contextWindow: 128_000 }, { id: 'lite', contextTokens: 32_000 }] } } } };
    expect(resolveContextWindow(config, 'deepseek/v4')).toBe(128_000);
    expect(resolveContextWindow(config, 'deepseek/lite')).toBe(32_000);
    expect(resolveContextWindow(config, 'deepseek/other')).toBe(64_000);
    expect(resolveContextWindow(config, 'nope/v4')).toBeNull();
    expect(resolveContextWindow(config, 'claude-code')).toBeNull();
  });

  it('/usage 合计与占用；网关 sessions.compact 回应 → 压缩结果', () => {
    expect(usageCommandResult([row({ input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }), row({ id: 2, input_tokens: 20, output_tokens: 1 })], 100).usage)
      .toMatchObject({ inputTokens: 30, outputTokens: 6, totalTokens: 36, contextTokens: 21, contextWindow: 100, contextPercent: 21 });
    expect(compactCommandResult({ ok: true, compacted: true, result: { tokensBefore: 243868, tokensAfter: 34941 } }))
      .toEqual({ command: 'compact', ok: true, compaction: { trigger: 'manual', preTokens: 243868, postTokens: 34941, summary: undefined } });
    expect(compactCommandResult({ ok: false, reason: 'busy' })).toEqual({ command: 'compact', ok: false, error: 'busy' });
  });

  it('超长错误 → chat.contextWindowTooSmall；普通错误不误判；很长的文本不扫', () => {
    expect(isContextWindowTooSmallError("This model's maximum context length is 128000 tokens")).toBe(true);
    expect(isContextWindowTooSmallError('Error: prompt is too long: 250000 tokens > 200000 maximum')).toBe(true);
    expect(isContextWindowTooSmallError('HTTP 401 - invalid api key')).toBe(false);
    expect(isContextWindowTooSmallError(`maximum context length ${'x'.repeat(5000)}`)).toBe(false);
    expect(createStructuredChatError('context_length_exceeded').messageCode).toBe('chat.contextWindowTooSmall');
    expect(createStructuredChatError('boom').messageCode).toBe('chat.runError');
  });
});

describe('OpenClaw 会话的 /compact 与 /usage（假网关）', () => {
  let h: AppHarness;
  beforeAll(async () => { h = await startAppHarness(); });
  afterAll(async () => { await h.close(); });

  it('/compact 调网关 sessions.compact（会话键与 Agent），结果落成结构化 system 消息；上下文占用接口按用量行算', async () => {
    const gw = new FakeGatewayClient();
    gw.rpcResponses['sessions.compact'] = { ok: true, key: 'agent:main:cmp-1', compacted: true, result: { tokensBefore: 9000, tokensAfter: 1200 } };
    h.ctx.sessionManager.createSession({ id: 'cmp-1', name: 'Tester', agentId: 'main' });
    pinFakeGateway(h.ctx, 'cmp-1', gw);
    const response = await fetch(`${h.baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'cmp-1', message: '/compact' }) });
    const sse = readSse(response);
    await sse.end();
    expect(gw.calls).toEqual([{ method: 'sessions.compact', params: expect.objectContaining({ agentId: 'main' }) }]);
    expect(gw.sent).toHaveLength(0);
    const final = sse.frames.find((frame) => frame.type === 'final');
    expect(final).toMatchObject({ role: 'system', messageCode: 'runtimeCommand.compactDone', messageParams: { preTokens: 9000, postTokens: 1200 } });
    const rows = h.ctx.db.getMessages('cmp-1');
    expect(rows.map((r: any) => r.role)).toEqual(['user', 'system']);

    h.ctx.db.recordSessionUsage({ sessionKey: 'cmp-1', callId: 'c1', source: 'openclaw', agentId: 'main', scope: 'model_call', purpose: null, model: null, provider: null, apiCalls: 1, inputTokens: 700, outputTokens: 50, cacheReadTokens: 250, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: null });
    const usage = await (await fetch(`${h.baseUrl}/api/chat/cmp-1/context-usage`)).json() as any;
    expect(usage).toMatchObject({ success: true, usedTokens: 1000 });
  });
});
