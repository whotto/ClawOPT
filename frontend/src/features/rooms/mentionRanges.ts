/**
 * 输入框里的结构化 @（P3 任务 1，spec 02 F2）：从候选里选中的 @ 记成区间 `{ start, end, memberId, name }`，
 * 随着用户编辑平移 / 失效；发送时只把「区间里仍然是 `@名字`」的那些变成结构化 @ 发给服务端。
 *
 * 规则：
 * - 编辑区域与区间有交叠（改了名字中间的字）→ 这个 @ 失效（回到纯文本，由服务端按文本解析兜底）；
 * - 编辑发生在区间之前 → 区间整体平移；之后 → 不动；
 * - 发送时再按文本核对一次（粘贴 / 撤销等浏览器操作可能让区间与文本对不上），对不上的丢弃；
 * - 没有任何有效区间时返回 `undefined`（三态里的「没给」：服务端按文本解析），有则返回数组。
 */
export type MentionRange = { start: number; end: number; memberId: string; name: string };
export type StructuredMentionInput = { type: 'agent'; participantId: string; displayName: string } | { type: 'all'; displayName: 'all' };

export const ALL_MENTION_ID = '__all__';

/** 前后文本的最小编辑区间：`[start, prevEnd)` 在旧文本里被替换成 `[start, nextEnd)`。 */
export function diffEditRegion(prev: string, next: string): { start: number; prevEnd: number; nextEnd: number } {
  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start += 1;
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }
  return { start, prevEnd, nextEnd };
}

/** 文本从 prev 变成 next 之后，区间怎么变。 */
export function rebaseMentionRanges(prev: string, next: string, ranges: MentionRange[]): MentionRange[] {
  if (prev === next || ranges.length === 0) return ranges;
  const { start, prevEnd, nextEnd } = diffEditRegion(prev, next);
  const shift = nextEnd - prevEnd;
  const out: MentionRange[] = [];
  for (const range of ranges) {
    if (range.end <= start) {
      out.push(range);
    } else if (range.start >= prevEnd) {
      out.push({ ...range, start: range.start + shift, end: range.end + shift });
    }
    // 交叠：失效。纯插入（start === prevEnd）落在区间严格内部也算交叠。
  }
  return out.filter((range) => next.slice(range.start, range.end) === `@${range.name}`);
}

/** 在光标处插入一个 @（替换光标前正在输入的 `@过滤词`），返回新文本、新光标与新区间表。 */
export function insertMentionAt(
  text: string,
  cursor: number,
  member: { memberId: string; name: string },
  ranges: MentionRange[],
): { text: string; cursor: number; ranges: MentionRange[] } {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  const replaceFrom = at >= 0 && !/\s/.test(before.slice(at + 1)) ? at : cursor;
  const token = `@${member.name}`;
  const nextText = `${text.slice(0, replaceFrom)}${token} ${text.slice(cursor)}`;
  const delta = token.length + 1 - (cursor - replaceFrom);
  const shifted = ranges.flatMap((range) => {
    if (range.end <= replaceFrom) return [range];
    if (range.start >= cursor) return [{ ...range, start: range.start + delta, end: range.end + delta }];
    return [];
  });
  const added: MentionRange = { start: replaceFrom, end: replaceFrom + token.length, memberId: member.memberId, name: member.name };
  const all = [...shifted, added].sort((a, b) => a.start - b.start);
  return { text: nextText, cursor: replaceFrom + token.length + 1, ranges: all.filter((range) => nextText.slice(range.start, range.end) === `@${range.name}`) };
}

/** 发送时：有效区间 → 结构化 @（按出现顺序、去重）；一个都没有 → undefined。 */
export function buildStructuredMentions(text: string, ranges: MentionRange[]): StructuredMentionInput[] | undefined {
  const valid = ranges
    .filter((range) => text.slice(range.start, range.end) === `@${range.name}`)
    .sort((a, b) => a.start - b.start);
  if (valid.length === 0) return undefined;
  const seen = new Set<string>();
  const out: StructuredMentionInput[] = [];
  for (const range of valid) {
    if (seen.has(range.memberId)) continue;
    seen.add(range.memberId);
    out.push(range.memberId === ALL_MENTION_ID ? { type: 'all', displayName: 'all' } : { type: 'agent', participantId: range.memberId, displayName: range.name });
  }
  return out.slice(0, 64);
}

/** 光标前是否正在输入 @（返回过滤词），用于弹出候选。 */
export function activeMentionQuery(text: string, cursor: number): string | null {
  const match = text.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
  return match ? match[1] : null;
}
