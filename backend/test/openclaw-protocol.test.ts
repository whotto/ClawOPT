/**
 * 上游消息记录的解包。
 *
 * 这是手写的协议适配：网关返回的记录会把真正的消息层层套在 `message` 字段里，
 * 层数不固定。它回归时不会报错——只会让聊天内容错乱、时间戳丢失，
 * 而日志里什么都看不到。所以这些用例守的是「安静地错」这一类。
 */
import { describe, expect, it } from 'vitest';
import { normalizeOpenClawMessageRecord } from '../src/openclaw-client';

describe('消息解包', () => {
  it('已经是消息的记录原样返回', () => {
    const msg = { role: 'assistant', content: '你好' };
    expect(normalizeOpenClawMessageRecord(msg)).toEqual(msg);
  });

  it('拆掉一层信封', () => {
    const result = normalizeOpenClawMessageRecord({ type: 'message', message: { role: 'assistant', content: '内容' } });
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('内容');
  });

  it('拆到「已经像一条消息」为止，不继续深挖', () => {
    // 固定当前真实契约：外层信封被剥掉一次之后，若结果自身已带 role/content，
    // 就停在这里——里面残留的 message 字段被当作载荷而不是又一层信封。
    // 写这条不是断言它一定对，而是让将来的改动必须先撞上它：
    // 若哪天发现网关真会发多层信封，那次修改就是明知的，而不是顺手的。
    const doubled = normalizeOpenClawMessageRecord({
      type: 'message', message: { type: 'message', message: { role: 'user', content: '深层' } },
    });
    expect(doubled.content).toBeUndefined();

    const once = normalizeOpenClawMessageRecord({
      type: 'message', message: { role: 'assistant', message: { role: 'user', content: '深层' } },
    });
    expect(once.role).toBe('assistant');
    expect(once.message).toEqual({ role: 'user', content: '深层' });
  });

  it('外层时间戳在内层缺失时被保留——否则消息会掉到时间线开头', () => {
    const result = normalizeOpenClawMessageRecord({
      type: 'message', timestamp: 1234, createdAt: 'A',
      message: { role: 'assistant', content: 'x' },
    });
    expect(result.timestamp).toBe(1234);
    expect(result.createdAt).toBe('A');
  });

  it('内层时间戳优先于外层', () => {
    const result = normalizeOpenClawMessageRecord({
      type: 'message', timestamp: 1, message: { role: 'assistant', content: 'x', timestamp: 2 },
    });
    expect(result.timestamp).toBe(2);
  });

  it('不把普通的 message 字段误当信封拆开', () => {
    // 这里的 message 只是一段文本载荷，不是嵌套消息
    const record = { role: 'assistant', content: '正文', message: { text: '附加信息' } };
    expect(normalizeOpenClawMessageRecord(record)).toEqual(record);
  });

  it('循环引用不会死循环', () => {
    const a: any = { type: 'message' };
    a.message = a;
    expect(() => normalizeOpenClawMessageRecord(a)).not.toThrow();
  });

  it('异常输入原样返回，不抛错', () => {
    expect(normalizeOpenClawMessageRecord(null)).toBeNull();
    expect(normalizeOpenClawMessageRecord('文本')).toBe('文本');
    expect(normalizeOpenClawMessageRecord([1, 2])).toEqual([1, 2]);
  });

  it('识别错误型信封（只带 error 而没有 role/content）', () => {
    const result = normalizeOpenClawMessageRecord({ type: 'message', message: { error: 'boom', errorMessage: '炸了' } });
    expect(result.error).toBe('boom');
  });
});
