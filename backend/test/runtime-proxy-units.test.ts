import { describe, expect, it } from 'vitest';

import { isAuthPublicPath } from '../src/core/auth';
import { resolveUpstreamEndpoint } from '../src/runtime';
import { normalizeResponsesPassthroughFrame } from '../src/runtime/proxy/provider-proxy';
import { SseParser } from '../src/runtime/proxy/sse';
import { ChatStreamDecoder } from '../src/runtime/proxy/stream-decoders';
import { CumulativeOrDelta } from '../src/runtime/proxy/stream-neutral';
import { readProxyFixture } from './helpers/runtime-proxy-harness';

describe('上游端点解析', () => {
  it.each([
    ['https://api.openai.com', 'chat_completions', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.deepseek.com/v1/', 'chat_completions', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://open.bigmodel.cn/api/paas/v4', 'chat_completions', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['https://x.test/api/coding/paas/v4', 'chat_completions', 'https://x.test/api/coding/paas/v4/chat/completions'],
    ['https://x.test/v2beta', 'responses', 'https://x.test/v2beta/responses'],
    ['https://x.test/openai', 'responses', 'https://x.test/openai/responses'],
    ['https://x.test/custom/chat/completions', 'chat_completions', 'https://x.test/custom/chat/completions'],
    ['https://x.test/root', 'responses', 'https://x.test/root/v1/responses'],
    ['https://api.anthropic.com', 'anthropic_messages', 'https://api.anthropic.com/v1/messages'],
    ['https://api.moonshot.cn/anthropic', 'anthropic_messages', 'https://api.moonshot.cn/anthropic/v1/messages'],
    ['https://x.test/api/anthropic/v1', 'anthropic_messages', 'https://x.test/api/anthropic/v1/messages'],
    ['https://x.test/api/anthropic/v1/messages', 'anthropic_messages', 'https://x.test/api/anthropic/v1/messages'],
  ] as const)('%s + %s → %s', (base, mode, expected) => {
    expect(resolveUpstreamEndpoint(base, mode)).toBe(expected);
  });
});

describe('SSE 解析器', () => {
  it('按单字节切块、CRLF 行尾、被切开的多字节字符，事件与整块解析完全一致', () => {
    const fixture = readProxyFixture('chat-deepseek-reasoning-tool.sse');
    const whole = new SseParser().push(Buffer.from(fixture));
    const crlf = Buffer.from(fixture.replace(/\n/g, '\r\n'));
    const parser = new SseParser();
    const pieces = [];
    for (let i = 0; i < crlf.length; i += 1) pieces.push(...parser.push(crlf.subarray(i, i + 1)));
    pieces.push(...parser.end());
    expect(pieces.map((e) => e.data)).toEqual(whole.map((e) => e.data));
    expect(pieces.some((e) => e.data.includes('用户要看'))).toBe(true);
  });

  it('Chat 解码器遇到 [DONE] 收尾，只报一次终态', () => {
    const decoder = new ChatStreamDecoder();
    const events = new SseParser().push(readProxyFixture('chat-deepseek-reasoning-tool.sse')).flatMap((e) => decoder.push(e));
    events.push(...decoder.end());
    expect(events.filter((e) => e.kind === 'finish')).toEqual([{ kind: 'finish', reason: 'tool_calls' }]);
    expect(events.filter((e) => e.kind === 'tool_end')).toHaveLength(1);
  });

  it('累计快照与增量混用的思维字段只取新增部分；短块重复按真增量', () => {
    const tracker = new CumulativeOrDelta();
    expect(tracker.next('Thinking about the')).toBe('Thinking about the');
    expect(tracker.next('Thinking about the problem')).toBe(' problem');
    expect(tracker.next(' now')).toBe(' now');
    const short = new CumulativeOrDelta();
    expect(short.next('好')).toBe('好');
    expect(short.next('好')).toBe('好');
  });
});

describe('公开路径模式匹配', () => {
  it('`:key` 只匹配恰好一个非空段', () => {
    expect(isAuthPublicPath('/api/runtime-proxy/anthropic/abc/v1/messages')).toBe(true);
    expect(isAuthPublicPath('/api/runtime-proxy/responses/abc/v1/responses')).toBe(true);
    expect(isAuthPublicPath('/api/runtime-proxy/anthropic//v1/messages')).toBe(false);
    expect(isAuthPublicPath('/api/runtime-proxy/anthropic/a/b/v1/messages')).toBe(false);
    expect(isAuthPublicPath('/api/runtime-proxy/anthropic/abc/v1/messages/extra')).toBe(false);
    expect(isAuthPublicPath('/api/runtime-proxy/anthropicX/abc/v1/messages')).toBe(false);
    expect(isAuthPublicPath('/api/runtime/manager/runtimes')).toBe(false);
  });
});


describe('Responses 直通帧整理', () => {
  it('缺 created_at / sequence_number 才补；上游给了的不改', () => {
    const state = { createdAt: 1789450000, sequence: 0 };
    const a: any = { type: 'response.created', response: { id: 'r', status: 'in_progress' } };
    expect(normalizeResponsesPassthroughFrame(a, state)).toBe(true);
    expect(a).toMatchObject({ sequence_number: 0, response: { created_at: 1789450000 } });
    const b: any = { type: 'response.output_text.delta', sequence_number: 7, delta: 'x' };
    expect(normalizeResponsesPassthroughFrame(b, state)).toBe(false);
    const c: any = { type: 'response.completed', response: { id: 'r', created_at: 42 } };
    expect(normalizeResponsesPassthroughFrame(c, state)).toBe(true);
    expect(c).toMatchObject({ sequence_number: 8, response: { created_at: 42 } });
  });
});
