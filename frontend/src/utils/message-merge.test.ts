/**
 * 前端消息合并 —— 守的是一类**不会报错**的故障。
 *
 * ## 为什么这几条值得钉住
 *
 * 流式过程里，同一条消息会被 SSE 增量、历史对账、重连补拉三条路反复写。
 * 写错的后果不是异常，是**用户眼看着已经出来的回答被一段更短的旧文本盖回去**，
 * 或者半截回答停在那里被当成完整回答。日志里什么都看不到。
 *
 * 后端为同一条红线做了整整一个模块（`text-snapshot-protection.ts`）并配了用例；
 * 前端的同类逻辑此前**一个用例都没有**，`test:frontend` 的实现是 `tsc`。
 * `AGENTS.md` 反对的「同一条判据两处分家」，这里就是一处。
 *
 * 判据的核心只有一句：**已经显示出来的内容，不能被更短的内容覆盖**——
 * 除非新内容明确带着终态信号（explicit process state），那才说明这是一次
 * 真正的收尾，而不是一条迟到的旧帧。
 */
import { describe, it, expect } from 'vitest';
import {
  shouldPreferIncomingMessageContent,
  shouldPreferIncomingSupplementalContent,
  mergeMessagePreservingContent,
  mergeMessagePatchPreservingContent,
  mergeMessageCollectionPreservingContent,
  type ChatMessage,
} from './message-merge';

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '1',
  role: 'assistant',
  content: '',
  timestamp: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

describe('shouldPreferIncomingMessageContent · 内容取舍', () => {
  it('补丁里没有 content 字段时不动内容（不是「用空字符串覆盖」）', () => {
    // 只改 model 的补丁不该把正文清空。`hasOwnProperty` 与「值是不是空」
    // 是两件事，混淆它们就是一次静默清屏。
    expect(shouldPreferIncomingMessageContent(msg({ content: '已经写出来的回答' }), { model: 'x' }))
      .toBe(false);
  });

  it('流式增长：新内容是旧内容的延长 → 采用', () => {
    expect(shouldPreferIncomingMessageContent(
      msg({ content: '第一段' }), { content: '第一段第二段' },
    )).toBe(true);
  });

  it('**回退：新内容是旧内容的前缀 → 拒绝**（这条是整个模块存在的理由）', () => {
    // 一条迟到的旧帧，内容比屏幕上的短。采用它 = 用户看着答案被吃回去。
    expect(shouldPreferIncomingMessageContent(
      msg({ content: '完整的长回答，已经渲染在屏幕上' }), { content: '完整的长' },
    )).toBe(false);
  });

  it('但带着终态信号的短内容要采用——那是收尾，不是迟到', () => {
    // processStreaming: false 明确表示这一轮结束了，此时的短内容是最终版。
    expect(shouldPreferIncomingMessageContent(
      msg({ content: '完整的长回答' }),
      { content: '完整的长', processContent: '工具执行完毕', processStreaming: false },
    )).toBe(true);
  });

  it('空内容不覆盖非空内容', () => {
    expect(shouldPreferIncomingMessageContent(msg({ content: '有内容' }), { content: '' })).toBe(false);
    expect(shouldPreferIncomingMessageContent(msg({ content: '有内容' }), { content: '   ' })).toBe(false);
  });

  it('当前为空时任何内容都采用', () => {
    expect(shouldPreferIncomingMessageContent(msg({ content: '' }), { content: '第一帧' })).toBe(true);
  });

  it('系统消息两个方向都放行——它们是状态通告，不参与长短比较', () => {
    // 「已达最大转发深度」这类系统提示比正文短得多，按长度判会被永远挡住。
    expect(shouldPreferIncomingMessageContent(
      msg({ content: '很长的一段助手回答……' }),
      { content: '已达最大转发深度', role: 'system', messageCode: 'group.maxChainDepthReached' },
    )).toBe(true);
    expect(shouldPreferIncomingMessageContent(
      msg({ content: '系统提示', role: 'system', messageCode: 'group.x' }), { content: '正常回答' },
    )).toBe(true);
  });

  it('trim 后相同时，保留原始空白更多的那份', () => {
    // 尾部换行在 markdown 里是有语义的，不能因为「看起来一样」就丢掉。
    expect(shouldPreferIncomingMessageContent(msg({ content: '答案' }), { content: '答案\n\n' })).toBe(true);
    expect(shouldPreferIncomingMessageContent(msg({ content: '答案\n\n' }), { content: '答案' })).toBe(false);
  });
});

describe('mergeMessagePreservingContent · 合并时不丢内容', () => {
  it('回退的补丁被挡下，正文保持原样，其余字段照常合并', () => {
    const merged = mergeMessagePreservingContent(
      msg({ content: '完整的长回答' }),
      { content: '完整的长', model: 'claude-sonnet-5' },
    );
    expect(merged.content, '正文被更短的内容覆盖了').toBe('完整的长回答');
    expect(merged.model, '非内容字段也该照常合并').toBe('claude-sonnet-5');
  });

  it('增长的补丁被采用', () => {
    expect(mergeMessagePreservingContent(msg({ content: '第一段' }), { content: '第一段第二段' }).content)
      .toBe('第一段第二段');
  });

  it('processContent 同样不被更短的内容覆盖', () => {
    const merged = mergeMessagePreservingContent(
      msg({ content: 'x', processContent: '步骤一\n步骤二\n步骤三' }),
      { processContent: '步骤一' },
    );
    expect(merged.processContent).toBe('步骤一\n步骤二\n步骤三');
  });

  it('processStreaming 转 false 时，允许收回成已有内容的前缀', () => {
    const merged = mergeMessagePreservingContent(
      msg({ content: 'x', processContent: '步骤一\n步骤二\n步骤三' }),
      { processContent: '步骤一', processStreaming: false },
    );
    expect(merged.processContent).toBe('步骤一');
    expect(merged.processStreaming).toBe(false);
  });

  it('但终态信号**不是**「什么短内容都收」——毫不相干的短内容仍被拒', () => {
    // 写这条用例时我先假设了 allowShorterReplacement 等于「终态时一律采用」，
    // 结果是红的。查实现才看清：这个开关只放行「新内容是旧内容的前缀」与
    // 「新内容为空」两个分支；其余情况仍然按长度判。
    //
    // 这是对的——一条迟到的、内容完全不同的短帧，即便带着 processStreaming: false，
    // 也更可能是乱序而不是收尾。把它钉下来，免得下一个人像我一样想当然。
    const merged = mergeMessagePreservingContent(
      msg({ content: 'x', processContent: '步骤一\n步骤二\n步骤三' }),
      { processContent: '已完成', processStreaming: false },
    );
    expect(merged.processContent).toBe('步骤一\n步骤二\n步骤三');
    expect(merged.processStreaming).toBe(false);
  });

  it('终态信号带空过程内容时，允许清空', () => {
    const merged = mergeMessagePreservingContent(
      msg({ content: 'x', processContent: '步骤一' }),
      { processContent: '', processStreaming: false },
    );
    expect(merged.processContent).toBe('');
  });
});

describe('mergeMessagePatchPreservingContent · 补丁之间合并', () => {
  it('两条补丁排队时，后到的短内容不能吃掉先到的长内容', () => {
    // 批量刷新（STREAM_UPDATE_BATCH_MS）会把多条补丁攒起来再合并，
    // 合并顺序里同样要守这条，否则「攒着」本身就成了回退的来源。
    const merged = mergeMessagePatchPreservingContent(
      { content: '攒住的长内容' }, { content: '攒住的长' },
    );
    expect(merged.content).toBe('攒住的长内容');
  });

  it('先到的补丁没有 content 时，后到的内容照常落下', () => {
    expect(mergeMessagePatchPreservingContent({ model: 'x' }, { content: '新内容' }).content)
      .toBe('新内容');
  });
});

describe('mergeMessageCollectionPreservingContent · 整批对账', () => {
  it('按数字 id 排序，且对已有消息执行同样的内容保留', () => {
    const base = [msg({ id: '2', content: '第二条的完整回答' }), msg({ id: '1', content: '第一条' })];
    // 历史对账拉回来的那份可能比屏幕上的旧（分页/缓存），不能直接盖。
    const incoming = [msg({ id: '2', content: '第二条的完整' }), msg({ id: '3', content: '第三条' })];

    const merged = mergeMessageCollectionPreservingContent(base, incoming);

    expect(merged.map((m) => m.id), '没有按 id 升序排列').toEqual(['1', '2', '3']);
    expect(merged[1].content, '对账把屏幕上的内容盖回旧版本了').toBe('第二条的完整回答');
    expect(merged[2].content).toBe('第三条');
  });

  it('非数字 id（本地乐观消息）排在末尾，不打断已持久化消息的顺序', () => {
    const merged = mergeMessageCollectionPreservingContent(
      [msg({ id: 'local-pending', content: '刚发出去的' })],
      [msg({ id: '5', content: '服务端的' })],
    );
    expect(merged.map((m) => m.id)).toEqual(['5', 'local-pending']);
  });
});

describe('shouldPreferIncomingSupplementalContent · 过程内容', () => {
  it('默认不接受更短的替换', () => {
    expect(shouldPreferIncomingSupplementalContent('步骤一\n步骤二', '步骤一')).toBe(false);
  });

  it('allowShorterReplacement 时接受，包括清空', () => {
    expect(shouldPreferIncomingSupplementalContent('步骤一\n步骤二', '步骤一', { allowShorterReplacement: true }))
      .toBe(true);
    expect(shouldPreferIncomingSupplementalContent('步骤一', '', { allowShorterReplacement: true }))
      .toBe(true);
  });

  it('不允许时，空值不清空已有内容', () => {
    expect(shouldPreferIncomingSupplementalContent('步骤一', '')).toBe(false);
  });
});
