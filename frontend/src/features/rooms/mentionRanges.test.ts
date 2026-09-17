import { describe, expect, it } from 'vitest';

import {
  activeMentionQuery, ALL_MENTION_ID, buildStructuredMentions, diffEditRegion, insertMentionAt, rebaseMentionRanges, type MentionRange,
} from './mentionRanges';

const main = { memberId: 'gm-main', name: '主程' };
const pm = { memberId: 'gm-pm', name: 'Product Lead' };

describe('insertMentionAt · 选中候选', () => {
  it('替换光标前的 @过滤词，补空格，记区间', () => {
    const inserted = insertMentionAt('请 @主 看看', 4, main, []);
    expect(inserted.text).toBe('请 @主程  看看');
    expect(inserted.ranges).toEqual([{ start: 2, end: 5, memberId: 'gm-main', name: '主程' }]);
    expect(inserted.cursor).toBe(6);
  });

  it('在已有 @ 之前插入：旧区间整体平移', () => {
    const first = insertMentionAt('@', 1, pm, []);
    expect(first.text).toBe('@Product Lead ');
    const second = insertMentionAt(`@${first.text}`, 1, main, first.ranges.map((r) => ({ ...r, start: r.start + 1, end: r.end + 1 })));
    expect(buildStructuredMentions(second.text, second.ranges)).toEqual([
      { type: 'agent', participantId: 'gm-main', displayName: '主程' },
      { type: 'agent', participantId: 'gm-pm', displayName: 'Product Lead' },
    ]);
  });
});

describe('rebaseMentionRanges · 编辑', () => {
  const text = 'hi @主程 and @Product Lead ok';
  const ranges: MentionRange[] = [
    { start: 3, end: 6, ...main },
    { start: 11, end: 24, ...pm },
  ];

  it('区间之前插字：平移；之后改字：不动', () => {
    const next = `well, ${text}`;
    expect(rebaseMentionRanges(text, next, ranges).map((r) => [r.start, r.end])).toEqual([[9, 12], [17, 30]]);
    expect(rebaseMentionRanges(text, `${text}!`, ranges)).toEqual(ranges);
  });

  it('改了名字中间的字：这个 @ 失效，另一个保留', () => {
    const next = text.replace('Product Lead', 'Product Xead');
    expect(rebaseMentionRanges(text, next, ranges).map((r) => r.memberId)).toEqual(['gm-main']);
  });

  it('删掉整个 @：失效', () => {
    const next = text.replace('@主程 ', '');
    const rebased = rebaseMentionRanges(text, next, ranges);
    expect(rebased).toEqual([{ start: 7, end: 20, ...pm }]);
    expect(buildStructuredMentions(next, rebased)).toEqual([{ type: 'agent', participantId: 'gm-pm', displayName: 'Product Lead' }]);
  });

  it('diffEditRegion 找最小编辑区', () => {
    expect(diffEditRegion('abcdef', 'abXYef')).toEqual({ start: 2, prevEnd: 4, nextEnd: 4 });
    expect(diffEditRegion('abc', 'abc!')).toEqual({ start: 3, prevEnd: 3, nextEnd: 4 });
  });
});

describe('buildStructuredMentions · 发送', () => {
  it('没有有效区间 → undefined（服务端按文本解析）；区间与文本对不上的丢弃；去重', () => {
    expect(buildStructuredMentions('纯文本 @主程', [])).toBeUndefined();
    expect(buildStructuredMentions('@主X', [{ start: 0, end: 3, ...main }])).toBeUndefined();
    expect(buildStructuredMentions('@主程 @主程', [{ start: 0, end: 3, ...main }, { start: 4, end: 7, ...main }])).toHaveLength(1);
    expect(buildStructuredMentions('@all 开会', [{ start: 0, end: 4, memberId: ALL_MENTION_ID, name: 'all' }])).toEqual([{ type: 'all', displayName: 'all' }]);
  });

  it('activeMentionQuery：行首或空白后的 @ 才弹候选（邮箱不算）', () => {
    expect(activeMentionQuery('hi @主', 5)).toBe('主');
    expect(activeMentionQuery('@', 1)).toBe('');
    expect(activeMentionQuery('a@b.com', 7)).toBeNull();
  });
});
