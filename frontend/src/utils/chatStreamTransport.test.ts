/**
 * 单聊流通道开关：默认 SSE，只认 'ws' 这一个非默认值——拼错或被别的代码写坏的值一律回到 SSE，
 * 不能因为 localStorage 里一个脏值就把用户切到还在验证的通道上。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAT_STREAM_TRANSPORT, normalizeChatStreamTransport, readChatStreamTransport } from './chatStreamTransport';

describe('chatStreamTransport', () => {
  it('默认是 SSE', () => {
    expect(DEFAULT_CHAT_STREAM_TRANSPORT).toBe('sse');
    expect(readChatStreamTransport()).toBe('sse');
  });

  it('只有 ws 能切到 WebSocket，其余一律 SSE', () => {
    expect(normalizeChatStreamTransport('ws')).toBe('ws');
    for (const value of ['WS', 'websocket', '', null, undefined, 1]) {
      expect(normalizeChatStreamTransport(value)).toBe('sse');
    }
  });
});
