import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import en from '../../../locales/en.json';
import zhCN from '../../../locales/zh-CN.json';
import zhTW from '../../../locales/zh-TW.json';
import type { ChatMessage } from '../../../utils/message-merge';
import { mapStreamingContentPatch, resolveStructuredMessageContent } from './messageMapping';

/**
 * 外部运行时会话命令结果（后端 `session.command` → `runtimeCommand.*` 结构化消息）的前端落点：
 * 流里的 `final` 帧要带着码与参数落成 system 消息，三种语言都要真的译出来（不剩 `{{…}}`、不回退成英文兜底）。
 */
const FRAMES = [
  { type: 'final', text: 'backend fallback (compact)', role: 'system', messageCode: 'runtimeCommand.compactDone', messageParams: { trigger: 'manual', preTokens: 50000, postTokens: 9000 }, rawDetail: '摘要' },
  { type: 'final', text: 'Status: …', role: 'system', messageCode: 'runtimeCommand.statusDone', messageParams: { model: 'gemini-3.1-pro-preview', nativeSessionId: 's-1', thinkingLevel: 'high', messageCount: 2, autoCompaction: 'on' } },
  { type: 'final', text: 'Usage: …', role: 'system', messageCode: 'runtimeCommand.usageDone', messageParams: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, cacheWriteTokens: 0, costUsd: 0.0123, contextTokens: 6500, contextWindow: 1048576, contextPercent: 0.6 } },
  { type: 'final', text: 'backend fallback (failed)', role: 'system', messageCode: 'runtimeCommand.failed', messageParams: { command: 'compact', error: 'nope' }, rawDetail: 'nope' },
];

describe('会话命令结果：流帧 → 结构化 system 消息 → 三语文案', () => {
  it('final 帧带码时补丁里有角色、码、参数、详情；普通帧不受影响', () => {
    const patch = mapStreamingContentPatch(FRAMES[0]);
    expect(patch).toMatchObject({ role: 'system', messageCode: 'runtimeCommand.compactDone', messageParams: { preTokens: 50000 }, rawDetail: '摘要', processStreaming: false });
    const plain = mapStreamingContentPatch({ type: 'delta', text: 'hello', process_streaming: true });
    expect(plain).toEqual({ content: 'hello', processStreaming: true });
  });

  for (const [locale, resources] of [['en', en], ['zh-CN', zhCN], ['zh-TW', zhTW]] as const) {
    it(`${locale}：四种结果都译得出来`, async () => {
      const instance = i18next.createInstance();
      await instance.init({ lng: locale, resources: { [locale]: { translation: resources } }, interpolation: { escapeValue: false } });
      for (const frame of FRAMES) {
        const message = { id: '1', role: 'system', content: frame.text, timestamp: new Date(), ...mapStreamingContentPatch(frame) } as ChatMessage;
        const text = resolveStructuredMessageContent(message, instance.t);
        expect(text, `${locale} ${frame.messageCode}`).not.toBe(frame.text);
        expect(text).not.toContain('{{');
        expect(text).not.toBe(frame.messageCode);
      }
    });
  }
});
