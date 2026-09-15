// 输入框的每会话草稿、拖拽高度、回车判定、静默失败判定（纯函数，带单测）。
// 草稿与高度是按浏览器的便利偏好（localStorage），读坏了按缺省，不影响对话本身。

export const COMPOSER_DRAFTS_KEY = 'clawopt_composer_drafts';
export const COMPOSER_HEIGHT_KEY = 'clawopt_composer_height';
export const COMPOSER_MIN_HEIGHT = 44;
export const COMPOSER_DEFAULT_MAX_HEIGHT = 200;
export const COMPOSER_MAX_HEIGHT = 600;
const MAX_DRAFTS = 50;
const MAX_DRAFT_CHARS = 20_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readMap(storage: StorageLike): Record<string, { text: string; at: number }> {
  try {
    const value = JSON.parse(storage.getItem(COMPOSER_DRAFTS_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function readDraft(storage: StorageLike, key: string): string {
  const entry = readMap(storage)[key];
  return entry && typeof entry.text === 'string' ? entry.text : '';
}

/** 写草稿：空串删掉这一条；最多留最近 50 个会话的草稿，每条最多 2 万字符。 */
export function writeDraft(storage: StorageLike, key: string, text: string, now = Date.now()): void {
  try {
    const map = readMap(storage);
    if (!text.trim()) delete map[key];
    else map[key] = { text: text.slice(0, MAX_DRAFT_CHARS), at: now };
    const entries = Object.entries(map).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, MAX_DRAFTS);
    if (entries.length === 0) storage.removeItem(COMPOSER_DRAFTS_KEY);
    else storage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

export function clampComposerHeight(value: unknown): number {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return COMPOSER_DEFAULT_MAX_HEIGHT;
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT * 2, numeric));
}

/** 回车发送：Shift+Enter 换行；输入法组合中（isComposing / keyCode 229）的回车是在选词，不发送。 */
export function shouldSendOnEnter(event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  return true;
}

/**
 * 静默失败：一轮正常收尾，却没有任何正文、过程、结构化结果，也不是被停下 / 被插入打断。
 * 这时界面必须说出来（可能是密钥错、模型不支持、上下文超长），不能留一个空气泡。
 */
export function isSilentFailure(message: { content?: string; processContent?: string; messageCode?: string; role?: string; interrupted?: boolean } | undefined, options: { stopped: boolean }): boolean {
  if (!message || options.stopped || message.interrupted) return false;
  if (message.role === 'system' || message.messageCode) return false;
  return !String(message.content ?? '').trim() && !String(message.processContent ?? '').trim();
}
