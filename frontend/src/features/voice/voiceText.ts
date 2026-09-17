// 语音的纯逻辑：朗读前的文本清洗、自动朗读挑哪几条、录音状态机、输入框追加。都有单测（voiceText.test.ts）。

/** 朗读的上限：太长的回复只读开头（在句末截断），免得一条长回复念上几分钟。 */
export const SPOKEN_TEXT_MAX_CHARS = 1500;

/**
 * Markdown / 过程块 → 适合朗读的纯文本：代码块整段去掉（念代码没有意义）、图片去掉、链接只留文字、
 * 标题 / 强调 / 列表 / 引用标记去掉、HTML 标签去掉、空白折叠；超过上限在句末截断。
 */
export function toSpeakableText(markdown: string, maxChars = SPOKEN_TEXT_MAX_CHARS): string {
  let text = String(markdown ?? '');
  text = text.replace(/\[执行工作_Start\][\s\S]*?(\[执行工作_End\]|$)/g, ' ');
  text = text.replace(/```[\s\S]*?(```|$)/g, ' ');
  text = text.replace(/~~~[\s\S]*?(~~~|$)/g, ' ');
  text = text.replace(/\$\$[\s\S]*?\$\$/g, ' ');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s*([-*+]|\d+\.)\s+/gm, '');
  text = text.replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*$/gm, ' ');
  text = text.replace(/\|/g, ' ');
  text = text.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const boundary = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return (boundary > maxChars * 0.5 ? head.slice(0, boundary + 1) : head).trim();
}

export type ReadableMessage = { id: string | number; role: string; content: string; processStreaming?: boolean; timestamp?: Date | string | number };

/**
 * 自动朗读挑哪几条：只读「这次打开对话之后新出现、已经结束」的助手回复。
 * - 还在跑（busy）时不挑也不标记，等结束后再挑，免得念半句；
 * - 只看列表末尾几条：往上翻页加载的旧消息不会被当成新回复念出来；
 * - 时间早于打开对话的时刻的也不念（刷新页面不重读历史）；
 * - 挑过的 id 进 seen，同一条只念一次。
 */
export function pickRepliesToRead(input: {
  messages: ReadableMessage[];
  seen: Set<string>;
  busy: boolean;
  since: number;
  tail?: number;
}): ReadableMessage[] {
  if (input.busy) return [];
  const tailStart = input.messages.length - (input.tail ?? 3);
  // 已经见过的最后一条的位置：往上翻页加载的旧消息插在它前面，不算新回复。
  let lastSeenIndex = -1;
  input.messages.forEach((message, index) => {
    if (input.seen.has(String(message.id))) lastSeenIndex = index;
  });
  const picked: ReadableMessage[] = [];
  for (const [index, message] of input.messages.entries()) {
    const id = String(message.id);
    if (input.seen.has(id)) continue;
    // 流式中的不标记：等它结束（processStreaming 落下）再挑。
    if (message.role === 'assistant' && message.processStreaming && index >= tailStart) continue;
    input.seen.add(id);
    if (index < tailStart || index <= lastSeenIndex) continue;
    if (message.role !== 'assistant' || !message.content?.trim()) continue;
    const at = message.timestamp instanceof Date ? message.timestamp.getTime() : typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number(message.timestamp ?? NaN);
    if (Number.isFinite(at) && at < input.since) continue;
    picked.push(message);
  }
  return picked;
}

/** 识别结果追加进输入框（不发送）：已有内容时补一个分隔空格。 */
export function appendTranscript(current: string, transcript: string): string {
  const text = transcript.trim();
  if (!text) return current;
  if (!current.trim()) return text;
  return /\s$/.test(current) ? `${current}${text}` : `${current} ${text}`;
}

export type RecorderState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'recording'; startedAt: number }
  | { phase: 'transcribing' }
  | { phase: 'error'; code: string };

export type RecorderEvent =
  | { type: 'press' }
  | { type: 'granted'; at: number }
  | { type: 'release' }
  | { type: 'transcribed' }
  | { type: 'cancel' }
  | { type: 'fail'; code: string };

/**
 * 半双工按住说话的状态机：idle → requesting（要麦克风）→ recording → transcribing → idle；任何一步失败进 error，再按一次重来。
 * 松手早于授权（requesting 时 release）直接取消，不留一个没人管的录音。
 */
export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case 'press':
      return state.phase === 'idle' || state.phase === 'error' ? { phase: 'requesting' } : state;
    case 'granted':
      return state.phase === 'requesting' ? { phase: 'recording', startedAt: event.at } : state;
    case 'release':
      if (state.phase === 'recording') return { phase: 'transcribing' };
      if (state.phase === 'requesting') return { phase: 'idle' };
      return state;
    case 'transcribed':
      return state.phase === 'transcribing' ? { phase: 'idle' } : state;
    case 'cancel':
      return { phase: 'idle' };
    case 'fail':
      return { phase: 'error', code: event.code };
    default:
      return state;
  }
}

/** 录音太短（误触）不上传。 */
export const MIN_RECORDING_MS = 400;
