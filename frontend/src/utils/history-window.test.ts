/**
 * 历史窗口与游标。
 *
 * ## 守的是什么
 *
 * `AGENTS.md` 有一条硬规定：**历史分页必须保持游标式（`beforeId + limit`），
 * 永远不许退回 offset。** `nextBeforeId` 就是那个游标。它一旦被改成「已加载条数」
 * 之类的偏移量，症状不是报错，是翻页开始**重复或跳过消息**——而且只在消息量
 * 大了以后才显形，本机开发时很可能一路绿灯。
 *
 * 第二条同样安静：窗口把更早的消息裁掉了，却没有把 `hasMoreOlder` 置真。
 * 那些消息不会报错、不会消失，它们只是**再也翻不回来**。用户看到的是
 * 「我上周那段对话没了」，而日志里什么都没有。
 *
 * ## 一个坑先记在这里
 *
 * 游标取自 `parsePositiveCursorValue(id)`，而本地乐观消息的 id 不是数字
 * （`local-...`），解析结果是 `null`。于是当窗口最旧的一条恰好是本地消息时，
 * `nextBeforeId` 会是 `null` —— 即使 `hasMoreOlder` 为真。下面把这个行为如实
 * 钉住：不是说它对，而是让将来改动它的人必须先撞上这条。
 */
import { describe, it, expect } from 'vitest';
import {
  HISTORY_FETCH_BATCH_MIN_LIMIT,
  buildLinearHistoryWindowSnapshot,
  createEmptyHistoryPageInfo,
  normalizeHistoryPageInfo,
  areHistoryPageInfosEqual,
  areMessageListsEquivalent,
} from './history-window';
import type { ChatMessage } from './message-merge';

const msg = (id: string, role: ChatMessage['role'] = 'assistant'): ChatMessage => ({
  id, role, content: `内容 ${id}`, timestamp: new Date('2026-01-01T00:00:00Z'),
});

/** 造 n 轮「用户提问 + 助手回答」，id 从 1 递增。 */
const rounds = (n: number): ChatMessage[] => {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(msg(String(i * 2 + 1), 'user'));
    out.push(msg(String(i * 2 + 2), 'assistant'));
  }
  return out;
};

const leafOf = (list: ChatMessage[]) => (list.length ? list[list.length - 1].id : null);
const emptyInfo = createEmptyHistoryPageInfo();

describe('窗口裁剪', () => {
  it('轮数没超上限时原样返回，不动 hasMoreOlder', () => {
    const messages = rounds(3);
    const snap = buildLinearHistoryWindowSnapshot(messages, emptyInfo, 10, leafOf);

    expect(snap.messages).toHaveLength(6);
    expect(snap.pageInfo.hasMoreOlder).toBe(false);
    expect(snap.activeLeafId).toBe('6');
  });

  it('超出上限时只保留最近 N 轮', () => {
    const snap = buildLinearHistoryWindowSnapshot(rounds(10), emptyInfo, 3, leafOf);
    // 保留最近 3 轮 = 从第 8 轮的 user（id 15）开始
    expect(snap.messages[0].id).toBe('15');
    expect(snap.messages).toHaveLength(6);
  });

  it('**裁掉了更早的消息就必须把 hasMoreOlder 置真**', () => {
    // 不置真的后果不是报错——是那些消息再也翻不回来。
    const snap = buildLinearHistoryWindowSnapshot(rounds(10), emptyInfo, 3, leafOf);
    expect(snap.pageInfo.hasMoreOlder, '裁剪了却没标记还有更早的，历史被静默截断').toBe(true);
  });

  it('上游已经说了还有更早的，裁不裁都保持真', () => {
    const info = { ...emptyInfo, hasMoreOlder: true };
    const snap = buildLinearHistoryWindowSnapshot(rounds(2), info, 10, leafOf);
    expect(snap.pageInfo.hasMoreOlder).toBe(true);
  });

  it('空列表返回空页信息，并保留 limit', () => {
    const snap = buildLinearHistoryWindowSnapshot([], { ...emptyInfo, limit: 77 }, 10, leafOf);
    expect(snap.messages).toHaveLength(0);
    expect(snap.pageInfo.limit).toBe(77);
    expect(snap.pageInfo.hasMoreOlder).toBe(false);
    expect(snap.activeLeafId).toBeNull();
  });

  it('activeLeafId 取的是**裁剪后**的末条，不是裁剪前的', () => {
    const snap = buildLinearHistoryWindowSnapshot(rounds(10), emptyInfo, 2, leafOf);
    expect(snap.activeLeafId).toBe(snap.messages[snap.messages.length - 1].id);
  });
});

describe('游标（AGENTS.md：必须 beforeId + limit，永不 offset）', () => {
  it('nextBeforeId 是**最旧那条的 id**，不是条数', () => {
    const snap = buildLinearHistoryWindowSnapshot(rounds(10), emptyInfo, 3, leafOf);
    // 裁剪后最旧一条是 id=15；若有人把它改成「已加载 6 条」之类的偏移量，这里会红。
    expect(snap.pageInfo.nextBeforeId).toBe(15);
    expect(snap.pageInfo.nextBeforeId).toBe(Number(snap.messages[0].id));
    expect(snap.pageInfo.nextBeforeId).not.toBe(snap.messages.length);
  });

  it('没有更早的消息时游标为 null——不能给出一个「翻到头了还能翻」的游标', () => {
    const snap = buildLinearHistoryWindowSnapshot(rounds(2), emptyInfo, 10, leafOf);
    expect(snap.pageInfo.hasMoreOlder).toBe(false);
    expect(snap.pageInfo.nextBeforeId).toBeNull();
  });

  it('oldestLoadedId / newestLoadedId 是窗口两端的真实 id', () => {
    const snap = buildLinearHistoryWindowSnapshot(rounds(10), emptyInfo, 3, leafOf);
    expect(snap.pageInfo.oldestLoadedId).toBe(15);
    expect(snap.pageInfo.newestLoadedId).toBe(20);
  });

  it('最旧一条是本地乐观消息时，游标为 null（如实记录当前行为）', () => {
    // id 不是数字 → parsePositiveCursorValue 返回 null → 翻页在这一刻拿不到游标。
    // 钉住它不是说它对，是让改动的人必须先看见这条。
    const messages = [msg('local-pending', 'user'), ...rounds(5)];
    const snap = buildLinearHistoryWindowSnapshot(messages, { ...emptyInfo, hasMoreOlder: true }, 99, leafOf);
    expect(snap.messages[0].id).toBe('local-pending');
    expect(snap.pageInfo.hasMoreOlder).toBe(true);
    expect(snap.pageInfo.nextBeforeId).toBeNull();
  });
});

describe('normalizeHistoryPageInfo · 消化后端给的分页信息', () => {
  it('缺 limit 时用兜底值', () => {
    expect(normalizeHistoryPageInfo({}).limit).toBe(HISTORY_FETCH_BATCH_MIN_LIMIT);
    expect(normalizeHistoryPageInfo({}, 12).limit).toBe(12);
  });

  it('hasMoreOlder 为假时游标一律清空', () => {
    const info = normalizeHistoryPageInfo({ hasMoreOlder: false, nextBeforeId: 42, oldestLoadedId: 42 });
    expect(info.nextBeforeId).toBeNull();
  });

  it('hasMoreOlder 为真但没给 nextBeforeId 时，退回 oldestLoadedId', () => {
    const info = normalizeHistoryPageInfo({ hasMoreOlder: true, oldestLoadedId: 42 });
    expect(info.nextBeforeId).toBe(42);
  });

  it('非法游标值被丢弃，而不是带着 NaN 往下传', () => {
    const info = normalizeHistoryPageInfo({ hasMoreOlder: true, nextBeforeId: 'abc', oldestLoadedId: -3 });
    expect(info.nextBeforeId).toBeNull();
    expect(info.oldestLoadedId).toBeNull();
  });

  it('畸形输入不抛错', () => {
    expect(() => normalizeHistoryPageInfo(null)).not.toThrow();
    expect(() => normalizeHistoryPageInfo(undefined)).not.toThrow();
  });
});

describe('相等判定（决定要不要重渲染）', () => {
  it('页信息逐字段比较', () => {
    const a = createEmptyHistoryPageInfo(40);
    expect(areHistoryPageInfosEqual(a, createEmptyHistoryPageInfo(40))).toBe(true);
    expect(areHistoryPageInfosEqual(a, { ...a, hasMoreOlder: true })).toBe(false);
    expect(areHistoryPageInfosEqual(a, { ...a, nextBeforeId: 9 })).toBe(false);
  });

  it('消息列表按 id 顺序比较，长度不同直接判不等', () => {
    expect(areMessageListsEquivalent(rounds(2), rounds(2))).toBe(true);
    expect(areMessageListsEquivalent(rounds(2), rounds(3))).toBe(false);
  });

  it('**内容变了但 id 没变时判定为「等价」**——重渲染另有判据', () => {
    // 这条容易被误读成 bug。它只回答「列表结构变没变」，正文的增量走
    // message-merge 那条路。改这条会让流式过程中的每一帧都重排整个列表。
    const left = [msg('1')];
    const right = [{ ...msg('1'), content: '完全不同的内容' }];
    expect(areMessageListsEquivalent(left, right)).toBe(true);
  });
});
