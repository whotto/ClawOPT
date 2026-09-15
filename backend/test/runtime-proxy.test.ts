/**
 * 本地模型代理：六个翻译方向（2 种客户端 × 3 种上游）走真实 HTTP，上游回放签入的流夹具。
 *
 * 夹具（test/fixtures/runtime-proxy/*.sse）按各家线协议的真实帧形状写成，**不是抓包**——
 * 本机没有这些服务商的 key。它们钉住的是「翻译器对这种形状的反应」，真实服务商的偏差由适配器真机 E2E 兜。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProxyTarget } from '../src/runtime';
import {
  createProxyHarness,
  localize,
  parseSseText,
  readProxyFixture,
  SSE_HEADERS,
  type ProxyHarness,
} from './helpers/runtime-proxy-harness';

function target(overrides: Partial<ProxyTarget> = {}): ProxyTarget {
  return {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseUrl: 'https://upstream.test/v1',
    apiKey: 'sk-upstream-secret-123',
    apiMode: 'chat_completions',
    runtime: 'claude-code',
    runId: 'run-1',
    sessionId: 'session-1',
    ...overrides,
  };
}

let harness: ProxyHarness;
let tmpDirs: string[] = [];

beforeEach(async () => {
  harness = await createProxyHarness();
});

afterEach(async () => {
  await harness.close();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

describe('鉴权', () => {
  it('未知 key 404、令牌不符 401，错误体按客户端协议的形状；x-api-key 与 Bearer 都认', async () => {
    const registered = harness.proxy.register(target());
    const models = `${localize(harness, registered.anthropicBaseUrl)}/v1/models`;

    const unknown = await fetch(models.replace(registered.routeKey, 'nope'), { headers: { 'x-api-key': registered.token } });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.type).toBe('not_found_error');

    const bad = await fetch(models, { headers: { 'x-api-key': `${registered.token}x` } });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });

    const responsesBad = await fetch(`${localize(harness, registered.responsesBaseUrl)}/models`, { headers: { authorization: 'Bearer wrong' } });
    expect(responsesBad.status).toBe(401);
    expect(await responsesBad.json()).toMatchObject({ error: { type: 'authentication_error' } });

    const viaHeader = await fetch(models, { headers: { 'x-api-key': registered.token } });
    expect(viaHeader.status).toBe(200);
    const ids = (await viaHeader.json()).data.map((m: any) => m.id);
    expect(ids).toContain('deepseek-reasoner');
    expect(ids.filter((id: string) => id.startsWith('claude-')).length).toBe(3);

    const viaBearer = await fetch(`${localize(harness, registered.responsesBaseUrl)}/models`, { headers: { authorization: `Bearer ${registered.token}` } });
    expect((await viaBearer.json()).data).toEqual([expect.objectContaining({ id: 'deepseek-reasoner' })]);
  });

  it('同一坐标重复登记拿到同一个令牌；revoke 后 404；旧句柄的 revoke 不误删', async () => {
    const first = harness.proxy.register(target());
    const second = harness.proxy.register(target({ runId: 'run-2', apiKey: 'sk-rotated' }));
    expect(second.token).toBe(first.token);
    expect(second.routeKey).toBe(first.routeKey);
    expect(first.anthropicBaseUrl.endsWith(`/api/runtime-proxy/anthropic/${first.routeKey}`)).toBe(true);
    expect(first.responsesBaseUrl.endsWith(`/api/runtime-proxy/responses/${first.routeKey}/v1`)).toBe(true);
    second.revoke();
    const gone = await fetch(`${localize(harness, first.anthropicBaseUrl)}/v1/models`, { headers: { 'x-api-key': first.token } });
    expect(gone.status).toBe(404);
  });

  it('上游 key 从不出现在给 CLI 的响应里', async () => {
    const registered = harness.proxy.register(target({ apiKey: 'sk-must-not-leak' }));
    harness.replies.push({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': registered.token });
    expect(res.status).toBe(401);
    expect(res.text).not.toContain('sk-must-not-leak');
    expect(harness.upstreamRequests[0].headers.authorization).toBe('Bearer sk-must-not-leak');
  });
});

describe('Anthropic 客户端（Claude Code）', () => {
  it('→ Chat 上游（DeepSeek）：请求翻译、流转成 Anthropic SSE、tee 出规范事件与用量', async () => {
    const registered = harness.proxy.register(target({ reasoningEffort: 'high' }));
    harness.proxy.onCanonicalEvent('run-1', (event) => harness.events.push(event));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('chat-deepseek-reasoning-tool.sse'), chunkBytes: 7 });

    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, {
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      stream: true,
      system: [{ type: 'text', text: 'You are a coding agent.' }],
      tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'list files' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'earlier thought', signature: 'x' }, { type: 'tool_use', id: 'call_prev', name: 'Bash', input: { command: 'pwd' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_prev', content: [{ type: 'text', text: '/work' }] }, { type: 'text', text: 'go on' }] },
      ],
    }, { 'x-api-key': registered.token });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const upstream = harness.upstreamRequests[0];
    expect(upstream.url).toBe('/v1/chat/completions');
    expect(upstream.body.model).toBe('deepseek-reasoner');
    expect(upstream.body.stream_options).toEqual({ include_usage: true });
    expect(upstream.body.reasoning_effort).toBe('high');
    expect(upstream.body.messages[0]).toEqual({ role: 'system', content: 'You are a coding agent.' });
    // DeepSeek 要求带思维的助手轮次回传 reasoning_content。
    expect(upstream.body.messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'earlier thought', tool_calls: [{ id: 'call_prev', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] });
    expect(upstream.body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_prev', content: '/work' });
    expect(upstream.body.messages[4]).toEqual({ role: 'user', content: 'go on' });
    expect(upstream.body.tools[0]).toMatchObject({ type: 'function', function: { name: 'Bash' } });

    const frames = parseSseText(res.text);
    const types = frames.map((f) => f.data.type);
    expect(types[0]).toBe('message_start');
    expect(frames[0].data.message.model).toBe('claude-sonnet-4-5');
    expect(types.slice(-2)).toEqual(['message_delta', 'message_stop']);
    const blockStarts = frames.filter((f) => f.data.type === 'content_block_start').map((f) => f.data.content_block.type);
    expect(blockStarts).toEqual(['thinking', 'text', 'tool_use']);
    const thinking = frames.filter((f) => f.data.delta?.type === 'thinking_delta').map((f) => f.data.delta.thinking).join('');
    expect(thinking).toBe('用户要看目录。');
    const text = frames.filter((f) => f.data.delta?.type === 'text_delta').map((f) => f.data.delta.text).join('');
    expect(text).toBe('我先列一下文件。');
    const toolStart = frames.find((f) => f.data.content_block?.type === 'tool_use')!.data.content_block;
    expect(toolStart).toMatchObject({ id: 'call_ls_1', name: 'Bash' });
    const args = frames.filter((f) => f.data.delta?.type === 'input_json_delta').map((f) => f.data.delta.partial_json).join('');
    expect(JSON.parse(args)).toEqual({ command: 'ls -la' });
    const delta = frames.find((f) => f.data.type === 'message_delta')!.data;
    expect(delta.delta.stop_reason).toBe('tool_use');
    expect(delta.usage).toMatchObject({ input_tokens: 1200, output_tokens: 85, cache_read_input_tokens: 1024 });

    const usage = harness.events.filter((e) => e.type === 'usage.reported');
    expect(usage).toHaveLength(1);
    expect((usage[0] as any).usage).toMatchObject({
      callId: 'claude-code:proxy:session-1:chatcmpl-ds-001',
      inputTokens: 1200,
      outputTokens: 85,
      cacheReadTokens: 1024,
      reasoningTokens: 40,
      provider: 'deepseek',
    });
    expect(harness.events.some((e) => e.type === 'response.output_text.delta')).toBe(true);
    expect(harness.events.find((e) => e.type === 'response.output_item.done' && (e as any).item.type === 'function_call')).toBeTruthy();
    expect(harness.events.at(-1)).toMatchObject({ type: 'response.completed', output_text: '我先列一下文件。' });
  });

  it('→ Chat 上游（非 DeepSeek 家族）不回传 reasoning_content', async () => {
    const registered = harness.proxy.register(target({ provider: 'openrouter', model: 'qwen3-coder', baseUrl: 'https://upstream.test/api/v1' }));
    harness.replies.push({ body: JSON.stringify({ id: 'c1', model: 'qwen3-coder', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, {
      model: 'claude-sonnet-4-5', max_tokens: 10,
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'b' }] }, { role: 'user', content: 'c' }],
    }, { 'x-api-key': registered.token });
    expect(res.status).toBe(200);
    expect(harness.upstreamRequests[0].url).toBe('/api/v1/chat/completions');
    expect(harness.upstreamRequests[0].body.messages[1]).toEqual({ role: 'assistant', content: 'b' });
    expect(JSON.parse(res.text)).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } });
  });

  it('→ Responses 上游：Responses SSE 转 Anthropic SSE', async () => {
    const registered = harness.proxy.register(target({ provider: 'openai', model: 'gpt-5.1-codex', apiMode: 'responses' }));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('responses-text-tool.sse'), chunkBytes: 13 });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, {
      model: 'claude-opus-4-5', max_tokens: 100, stream: true, system: 'sys',
      tools: [{ name: 'shell', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ls' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }],
    }, { 'x-api-key': registered.token });
    const upstream = harness.upstreamRequests[0];
    expect(upstream.url).toBe('/v1/responses');
    expect(upstream.body).toMatchObject({ model: 'gpt-5.1-codex', instructions: 'sys', stream: true, store: false, max_output_tokens: 100 });
    expect(upstream.body.input[0].content).toEqual([{ type: 'input_text', text: 'ls' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]);
    const frames = parseSseText(res.text);
    expect(frames.filter((f) => f.data.type === 'content_block_start').map((f) => f.data.content_block.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(frames.find((f) => f.data.type === 'message_delta')!.data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 2000, output_tokens: 120, cache_read_input_tokens: 1500 } });
  });

  it('→ Anthropic 上游直通：模型强制换成目标模型，帧原样，tee 照样出用量', async () => {
    const registered = harness.proxy.register(target({ provider: 'moonshot', model: 'kimi-k2-thinking', apiMode: 'anthropic_messages', baseUrl: 'https://upstream.test/anthropic' }));
    harness.proxy.onCanonicalEvent('run-1', (event) => harness.events.push(event));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('anthropic-thinking-tool.sse'), chunkBytes: 5 });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, { model: 'claude-sonnet-4-5', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': registered.token, 'anthropic-beta': 'interleaved-thinking-2025-05-14' });
    const upstream = harness.upstreamRequests[0];
    expect(upstream.url).toBe('/anthropic/v1/messages');
    expect(upstream.body.model).toBe('kimi-k2-thinking');
    expect(upstream.headers['x-api-key']).toBe('sk-upstream-secret-123');
    expect(upstream.headers['anthropic-version']).toBe('2023-06-01');
    expect(upstream.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    const frames = parseSseText(res.text);
    expect(frames.map((f) => f.event)).toEqual(parseSseText(readProxyFixture('anthropic-thinking-tool.sse')).map((f) => f.event));
    const usage = harness.events.find((e) => e.type === 'usage.reported') as any;
    expect(usage.usage).toMatchObject({ callId: 'claude-code:proxy:session-1:msg_up_001', inputTokens: 900, outputTokens: 64, cacheReadTokens: 512 });
  });
});

describe('Responses 客户端（Codex / Grok / OpenCode）', () => {
  it('→ Chat 上游：命名空间 / 分发 / 自定义工具展平，回来的调用还原成 Codex 认得的形状；用量不塞进终态帧', async () => {
    const registered = harness.proxy.register(target({ provider: 'openrouter', model: 'qwen3-coder', runtime: 'codex' }));
    harness.proxy.onCanonicalEvent('run-1', (event) => harness.events.push(event));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('chat-namespaced-tool.sse'), chunkBytes: 11 });
    const res = await postJson(`${localize(harness, registered.responsesBaseUrl)}/responses`, {
      model: 'gpt-5-codex',
      stream: true,
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev note' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find bugs' }] },
      ],
      tools: [
        { type: 'function', name: 'shell', parameters: { type: 'object' } },
        { type: 'namespace', name: 'mcp__github', tools: [{ type: 'function', name: 'search_issues', parameters: { type: 'object', properties: { query: { type: 'string' } } } }] },
        { type: 'namespace', name: 'mcp__linear', description: 'Linear tools' },
        { type: 'custom', name: 'apply_patch', description: 'Patch files', format: { type: 'grammar' } },
        { type: 'tool_search' },
      ],
      reasoning: { effort: 'medium' },
    }, { authorization: `Bearer ${registered.token}` });
    expect(res.status).toBe(200);

    const upstream = harness.upstreamRequests[0];
    expect(upstream.body.tools.map((t: any) => t.function.name)).toEqual(['shell', 'mcp__github__search_issues', 'mcp__linear', 'apply_patch', 'tool_search']);
    expect(upstream.body.messages[0]).toEqual({ role: 'system', content: 'be brief\n\ndev note' });
    expect(upstream.body.reasoning_effort).toBe('medium');

    const frames = parseSseText(res.text).map((f) => f.data);
    const done = frames.filter((f) => f.type === 'response.output_item.done').map((f) => f.item);
    expect(done).toEqual([
      expect.objectContaining({ type: 'function_call', name: 'search_issues', namespace: 'mcp__github', call_id: 'call_ns_1', arguments: '{"query":"bug"}' }),
      expect.objectContaining({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_patch_1', input: '*** Begin Patch\n*** End Patch' }),
      expect.objectContaining({ type: 'function_call', name: 'list_issues', namespace: 'mcp__linear', call_id: 'call_disp_1', arguments: '{"team":"core"}' }),
    ]);
    const sequence = frames.map((f) => f.sequence_number);
    expect(sequence).toEqual(sequence.map((_, i) => i));
    const completed = frames.at(-1);
    expect(completed.type).toBe('response.completed');
    expect(completed.response.usage).toBeUndefined();
    // tee 的工具调用用上游名；协调器按 Codex 的仲裁表只信 CLI 的工具事件，这里只要求存在。
    expect(harness.events.filter((e) => e.type === 'response.output_item.done').length).toBe(3);
  });

  /**
   * 形状取自集成 P2 时真 Codex 0.153.4（模型 gpt-5.4，MCP 工具延迟加载）发给代理的请求：
   * `tools` 里是 `{type: 'tool_search', execution: 'client'}`；搜到的命名空间工具只出现在历史的 `tool_search_output.tools` 里。
   * 修之前：还原成 `function_call name=tool_search`，Codex 不认、回 "aborted"；搜到的工具不进上游工具表，模型调不了。
   */
  it('→ Chat 上游：tool_search 还原成 tool_search_call（execution: client，参数是对象）；tool_search_output 里搜到的工具进上游工具表', async () => {
    const registered = harness.proxy.register(target({ provider: 'openrouter', model: 'qwen3-coder', runtime: 'codex' }));
    const searchCall = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_search_1","type":"function","function":{"name":"tool_search","arguments":"{\\"query\\":\\"echo\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    const echoCall = 'data: {"id":"c2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_echo_1","type":"function","function":{"name":"mcp__echo_mcp__echo","arguments":"{\\"text\\":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n';
    harness.replies.push({ headers: SSE_HEADERS, body: searchCall }, { headers: SSE_HEADERS, body: echoCall });
    const baseTools = [
      { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
      { type: 'tool_search', execution: 'client', description: 'Search deferred tools', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ];
    const first = await postJson(`${localize(harness, registered.responsesBaseUrl)}/responses`, {
      model: 'gpt-5.4', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call echo' }] }], tools: baseTools,
    }, { authorization: `Bearer ${registered.token}` });
    const firstDone = parseSseText(first.text).map((f) => f.data).filter((f) => f.type === 'response.output_item.done').map((f) => f.item);
    expect(firstDone).toEqual([expect.objectContaining({ type: 'tool_search_call', call_id: 'call_search_1', execution: 'client', arguments: { query: 'echo' } })]);

    const second = await postJson(`${localize(harness, registered.responsesBaseUrl)}/responses`, {
      model: 'gpt-5.4',
      stream: true,
      tools: baseTools,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call echo' }] },
        { type: 'tool_search_call', id: 'fc_1', call_id: 'call_search_1', status: 'completed', execution: 'client', arguments: { query: 'echo' } },
        {
          type: 'tool_search_output', id: 'tso_1', call_id: 'call_search_1', status: 'completed', execution: 'client',
          tools: [{ type: 'namespace', name: 'mcp__echo_mcp', description: 'Tools in the mcp__echo_mcp namespace.', tools: [{ type: 'function', name: 'echo', strict: false, defer_loading: true, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }],
        },
      ],
    }, { authorization: `Bearer ${registered.token}` });
    const upstreamSecond = harness.upstreamRequests[1].body;
    expect(upstreamSecond.tools.map((t: any) => t.function.name)).toEqual(['exec_command', 'tool_search', 'mcp__echo_mcp__echo']);
    expect(upstreamSecond.messages.find((m: any) => m.role === 'assistant').tool_calls[0]).toMatchObject({ id: 'call_search_1', function: { name: 'tool_search', arguments: '{"query":"echo"}' } });
    expect(upstreamSecond.messages.find((m: any) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call_search_1' });
    const secondDone = parseSseText(second.text).map((f) => f.data).filter((f) => f.type === 'response.output_item.done').map((f) => f.item);
    expect(secondDone).toEqual([expect.objectContaining({ type: 'function_call', name: 'echo', namespace: 'mcp__echo_mcp', call_id: 'call_echo_1', arguments: '{"text":"hi"}' })]);
  });

  it('→ Chat 上游（Grok）：system 改 developer、去掉 max_output_tokens', async () => {
    const registered = harness.proxy.register(target({ provider: 'xai', model: 'grok-code', runtime: 'grok', baseUrl: 'https://upstream.test/v1' }));
    harness.replies.push({ body: JSON.stringify({ id: 'g1', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) });
    const res = await postJson(`${localize(harness, registered.responsesBaseUrl)}/responses`, {
      model: 'grok', max_output_tokens: 99, input: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
    }, { authorization: `Bearer ${registered.token}` });
    expect(res.status).toBe(200);
    const body = harness.upstreamRequests[0].body;
    expect(body.messages[0]).toEqual({ role: 'developer', content: 'S' });
    expect(body.max_tokens).toBeUndefined();
    expect(JSON.parse(res.text)).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
  });

  it('→ Anthropic 上游：请求译成 Messages，流译回 Responses；OpenCode 的终态帧补全零用量', async () => {
    const registered = harness.proxy.register(target({ provider: 'anthropic-compatible', model: 'kimi-k2-thinking', apiMode: 'anthropic_messages', runtime: 'opencode', baseUrl: 'https://upstream.test/v1' }));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('anthropic-thinking-tool.sse') });
    const res = await postJson(`${localize(harness, registered.responsesBaseUrl)}/responses`, {
      model: 'm', stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
        { type: 'function_call', call_id: 'c0', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'c0', output: 'file a' },
      ],
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
    }, { authorization: `Bearer ${registered.token}` });
    const body = harness.upstreamRequests[0].body;
    expect(harness.upstreamRequests[0].url).toBe('/v1/messages');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c0', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: 'file a' }] },
    ]);
    expect(body.max_tokens).toBeGreaterThan(0);
    const frames = parseSseText(res.text).map((f) => f.data);
    expect(frames.filter((f) => f.type === 'response.output_item.done').map((f) => f.item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(frames.at(-1).response.usage).toEqual({ input_tokens: 900, input_tokens_details: { cached_tokens: 512 }, output_tokens: 64, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 964 });
  });

  it('→ Responses 上游直通：请求瘦身（旧图片、超长工具输出）照做；OpenCode 缺用量时补零', async () => {
    const registered = harness.proxy.register(target({ provider: 'opencode', model: 'free-model', apiMode: 'responses', runtime: 'opencode', baseUrl: 'https://opencode.ai/zen/v1' }));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('responses-no-usage.sse') });
    // 开头一个 ASCII 字节让 24 KiB 的切点落在三字节汉字中间（对齐的话切不坏，守卫就验不到）。
    const bigOutput = `x${'头'.repeat(20000)}${'尾'.repeat(20000)}`;
    const res = await postJson(`${localize(harness, registered.responsesBaseUrl)}/responses`, {
      model: 'x', stream: true,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(4000)}` }] },
        { type: 'function_call_output', call_id: 'c1', output: bigOutput },
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,BBBB' }, { type: 'input_text', text: 'now' }] },
      ],
    }, { authorization: `Bearer ${registered.token}` });
    const upstream = harness.upstreamRequests[0];
    expect(upstream.url).toBe('/zen/v1/responses');
    expect(upstream.headers['x-opencode-session']).toBe('session-1');
    expect(upstream.body.model).toBe('free-model');
    expect(upstream.body.input[0].content[0]).toEqual({ type: 'input_text', text: '[earlier image omitted by ClawOPT proxy: 3000 bytes]' });
    expect(upstream.body.input[2].content[0].image_url).toBe('data:image/png;base64,BBBB');
    const truncated: string = upstream.body.input[1].output;
    expect(Buffer.byteLength(truncated)).toBeLessThan(32 * 1024);
    expect(truncated.startsWith('x头')).toBe(true);
    expect(truncated.endsWith('尾')).toBe(true);
    expect(truncated).not.toContain('�');
    const completed = parseSseText(res.text).map((f) => f.data).find((f) => f.type === 'response.completed');
    expect(completed.response.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    // 上游没给 response.created_at（兼容 Responses 的上游常见）：直通时补上，同一流里一致；上游给的序号原样保留。
    // Grok 1.0.30 缺这个字段整轮报 `missing field created_at`（集成 P2 真机）。
    const frames = parseSseText(res.text).map((f) => f.data);
    const createdAts = frames.filter((f) => f.response).map((f) => f.response.created_at);
    expect(createdAts.every((value) => typeof value === 'number' && value === createdAts[0])).toBe(true);
    expect(frames.map((f) => f.sequence_number)).toEqual([0, 1, 2]);
  });
});

describe('加密思维块单次重试（非官方 Anthropic 兼容上游）', () => {
  const body = {
    model: 'claude-sonnet-4-5', max_tokens: 10, stream: true,
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'enc' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zzz' }, { type: 'text', text: 'b' }] },
      { role: 'user', content: 'c' },
    ],
  };

  it('HTTP 400 invalid_encrypted_content → 剥掉历史思维块重试一次', async () => {
    const registered = harness.proxy.register(target({ provider: 'custom:glm', model: 'glm-4.6', apiMode: 'anthropic_messages', baseUrl: 'https://upstream.test/api/anthropic' }));
    harness.replies.push({ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } }) });
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('anthropic-thinking-tool.sse') });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, body, { 'x-api-key': registered.token });
    expect(res.status).toBe(200);
    expect(harness.upstreamRequests).toHaveLength(2);
    expect(harness.upstreamRequests[1].body.messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: 'c' },
    ]);
  });

  it('200 SSE 里业务帧之前的 error 帧 → 重试一次，客户端看不到那个错误帧', async () => {
    const registered = harness.proxy.register(target({ provider: 'custom:glm', model: 'glm-4.6', apiMode: 'anthropic_messages', baseUrl: 'https://upstream.test/api/anthropic' }));
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('anthropic-encrypted-thinking-error.sse') });
    harness.replies.push({ headers: SSE_HEADERS, body: readProxyFixture('anthropic-thinking-tool.sse') });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, body, { 'x-api-key': registered.token });
    expect(harness.upstreamRequests).toHaveLength(2);
    const frames = parseSseText(res.text);
    expect(frames.some((f) => f.event === 'error')).toBe(false);
    expect(frames[0].event).toBe('message_start');
  });

  it('官方 Anthropic 与无关的 400 都不重试', async () => {
    const official = harness.proxy.register(target({ provider: 'anthropic', model: 'claude-sonnet-4-5', apiMode: 'anthropic_messages', baseUrl: 'https://api.anthropic.com' }));
    harness.replies.push({ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'x' } }) });
    const first = await postJson(`${localize(harness, official.anthropicBaseUrl)}/v1/messages`, body, { 'x-api-key': official.token });
    expect(first.status).toBe(400);
    expect(harness.upstreamRequests).toHaveLength(1);

    const custom = harness.proxy.register(target({ provider: 'custom:glm', model: 'glm-4.6', apiMode: 'anthropic_messages', baseUrl: 'https://upstream.test/api/anthropic' }));
    harness.replies.push({ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }) });
    const second = await postJson(`${localize(harness, custom.anthropicBaseUrl)}/v1/messages`, body, { 'x-api-key': custom.token });
    expect(second.status).toBe(400);
    expect(JSON.parse(second.text).error.message).toBe('max_tokens too large');
    expect(harness.upstreamRequests).toHaveLength(2);
  });
});

describe('出站地址策略', () => {
  it('非本地服务商解析到内网 → 403；本地服务商（ollama）放行；上游重定向不跟', async () => {
    await harness.close();
    harness = await createProxyHarness({ publicAddress: '10.0.0.5' });
    const blocked = harness.proxy.register(target({ provider: 'openai' }));
    const res = await postJson(`${localize(harness, blocked.anthropicBaseUrl)}/v1/messages`, { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] }, { 'x-api-key': blocked.token });
    expect(res.status).toBe(403);
    expect(harness.upstreamRequests).toHaveLength(0);

    const local = harness.proxy.register(target({ provider: 'ollama', model: 'qwen3', baseUrl: 'http://upstream.test:11434/v1' }));
    // 相对地址的重定向指回假上游自己：跟了的话假上游会收到第二个请求。
    harness.replies.push({ status: 302, headers: { location: '/v1/redirected' }, body: '' });
    harness.replies.push({ body: JSON.stringify({ id: 'r', choices: [{ message: { content: 'followed' }, finish_reason: 'stop' }] }) });
    const redirected = await postJson(`${localize(harness, local.anthropicBaseUrl)}/v1/messages`, { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] }, { 'x-api-key': local.token });
    expect(harness.upstreamRequests).toHaveLength(1);
    expect(redirected.status).toBe(502);
  });

  it('登记时拒绝非 http(s) 的 base URL', () => {
    expect(() => harness.proxy.register(target({ baseUrl: 'file:///etc/passwd' }))).toThrow(expect.objectContaining({ errorCode: 'net.protocolNotAllowed' }));
    expect(() => harness.proxy.register(target({ baseUrl: 'not a url' }))).toThrow();
  });
});

describe('重启恢复（加密目标文件）', () => {
  function tmpDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-clawopt-proxy-restore-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('新进程读回目标，同一令牌仍然有效；上游 key 不以明文落盘；密钥文件 0600', async () => {
    const dataDir = tmpDataDir();
    await harness.close();
    harness = await createProxyHarness({ dataDir });
    const registered = harness.proxy.register(target({ apiKey: 'sk-plaintext-canary' }));

    const files = fs.readdirSync(path.join(dataDir, 'proxy-targets'));
    expect(files).toEqual([`${registered.routeKey}.json`]);
    const raw = fs.readFileSync(path.join(dataDir, 'proxy-targets', files[0]), 'utf-8');
    expect(raw).not.toContain('sk-plaintext-canary');
    expect(fs.statSync(path.join(dataDir, 'proxy-target.key')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dataDir, 'proxy-targets', files[0])).mode & 0o777).toBe(0o600);

    await harness.close();
    harness = await createProxyHarness({ dataDir });
    expect(harness.proxy.restore()).toBe(1);
    harness.replies.push({ body: JSON.stringify({ id: 'r', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) });
    const res = await postJson(`${localize(harness, registered.anthropicBaseUrl)}/v1/messages`, { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'a' }] }, { 'x-api-key': registered.token });
    expect(res.status).toBe(200);
    expect(harness.upstreamRequests[0].headers.authorization).toBe('Bearer sk-plaintext-canary');
  });

  it('坐标被篡改（AAD 对不上）→ 不恢复', async () => {
    const dataDir = tmpDataDir();
    await harness.close();
    harness = await createProxyHarness({ dataDir });
    const registered = harness.proxy.register(target());
    const file = path.join(dataDir, 'proxy-targets', `${registered.routeKey}.json`);
    const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
    record.target.baseUrl = 'https://attacker.test/v1';
    fs.writeFileSync(file, JSON.stringify(record));

    await harness.close();
    harness = await createProxyHarness({ dataDir });
    expect(harness.proxy.restore()).toBe(0);
    const res = await fetch(`${localize(harness, registered.anthropicBaseUrl)}/v1/models`, { headers: { 'x-api-key': registered.token } });
    expect(res.status).toBe(404);
  });
});
