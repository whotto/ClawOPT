// 自动朗读（P6 语音）：开关打开时，把这次打开对话之后新出现、已经结束的助手回复念出来。不渲染任何东西。
// 挑选判据在 voiceText.ts 的 pickRepliesToRead（有单测）；切会话 / 群时重新起算，历史与翻页加载的旧消息不念。
import { useEffect, useRef } from 'react';
import { speakText, useAutoRead, useVoiceStatus } from './voiceRuntime';
import { pickRepliesToRead, type ReadableMessage } from './voiceText';

export function VoiceAutoReader({ messages, busy, activeKey }: { messages: ReadableMessage[]; busy: boolean; activeKey: string | null | undefined }) {
  const status = useVoiceStatus();
  const enabled = useAutoRead(status?.autoReadDefault ?? false) && status?.tts.configured === true;
  const seenRef = useRef(new Set<string>());
  const sinceRef = useRef(Date.now());

  useEffect(() => {
    // 换了对话：当前已经在列表里的都算见过，从这一刻起算。
    seenRef.current = new Set(messages.map((message) => String(message.id)));
    sinceRef.current = Date.now();
    // 只在对话切换时重置；messages 的变化由下面的 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  useEffect(() => {
    if (!enabled) {
      // 关着的时候也标记，免得一打开就把之前的回复补念一遍。
      for (const message of messages) {
        if (!(message.role === 'assistant' && message.processStreaming)) seenRef.current.add(String(message.id));
      }
      return;
    }
    const picked = pickRepliesToRead({ messages, seen: seenRef.current, busy, since: sinceRef.current });
    const latest = picked[picked.length - 1];
    if (latest) void speakText(latest.content).catch(() => undefined);
  }, [messages, busy, enabled]);

  return null;
}

export default VoiceAutoReader;
