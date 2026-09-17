/**
 * 群聊的本机记忆（P3 任务 1 / 2）：
 * - **每群草稿**：输入框没发出去的文字 + 结构化 @ 区间，按群存，30 天过期；切群、刷新都能恢复。发出去即清。
 * - **排队能力令牌**：每个群（每个浏览器）一枚随机串，随消息发给服务端；撤回排队中的消息时出示它。
 *   账号用户撤回按身份判，令牌是访客（没有账号）证明「这条是我发的」的唯一依据——服务端只存 SHA-256。
 *
 * 存储注入（默认 localStorage），读写失败一律静默（隐私模式 / 配额满）。
 */
import type { MentionRange } from './mentionRanges';

export const ROOM_DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_PREFIX = 'clawopt.room.draft.';
const CAPABILITY_PREFIX = 'clawopt.room.queueCapability.';

export type RoomDraft = { text: string; ranges: MentionRange[]; savedAt: number };

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const defaultStorage = (): StorageLike | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

export function loadRoomDraft(roomKey: string, now = Date.now(), storage: StorageLike | null = defaultStorage()): RoomDraft | null {
  if (!storage || !roomKey) return null;
  try {
    const raw = storage.getItem(DRAFT_PREFIX + roomKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RoomDraft;
    if (typeof parsed?.text !== 'string' || typeof parsed.savedAt !== 'number' || now - parsed.savedAt > ROOM_DRAFT_TTL_MS) {
      storage.removeItem(DRAFT_PREFIX + roomKey);
      return null;
    }
    return { text: parsed.text, ranges: Array.isArray(parsed.ranges) ? parsed.ranges : [], savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function saveRoomDraft(roomKey: string, text: string, ranges: MentionRange[], now = Date.now(), storage: StorageLike | null = defaultStorage()): void {
  if (!storage || !roomKey) return;
  try {
    if (!text.trim()) {
      storage.removeItem(DRAFT_PREFIX + roomKey);
      return;
    }
    storage.setItem(DRAFT_PREFIX + roomKey, JSON.stringify({ text: text.slice(0, 100_000), ranges, savedAt: now }));
  } catch {
    // 配额满 / 不可用：草稿只是便利，不打扰用户。
  }
}

/** 清掉所有过期草稿（打开群聊页时跑一次）。 */
export function sweepRoomDrafts(now = Date.now(), storage: StorageLike | null = defaultStorage()): number {
  if (!storage) return 0;
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      if (!loadRoomDraft(key.slice(DRAFT_PREFIX.length), now, storage)) removed += 1;
    }
  } catch {
    return removed;
  }
  return removed;
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function roomQueueCapability(roomKey: string, storage: StorageLike | null = defaultStorage()): string {
  try {
    const existing = storage?.getItem(CAPABILITY_PREFIX + roomKey);
    if (existing && /^[0-9a-f]{48}$/.test(existing)) return existing;
    const token = randomToken();
    storage?.setItem(CAPABILITY_PREFIX + roomKey, token);
    return token;
  } catch {
    return randomToken();
  }
}
