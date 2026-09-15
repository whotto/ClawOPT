// 一次性的输入框预填：别的页面（运行时管理页的「让 AI 诊断」）把一段文字交给某个单聊，
// 聊天页打开那个会话时取走并清掉。只放进输入框，**从不自动发送**。
// 用 sessionStorage：只在这个标签页里有效，关掉就没了；取不到存储（隐私模式）时静默退化成不预填。

const KEY_PREFIX = 'clawopt_composer_prefill:';

export function writeComposerPrefill(sessionId: string, text: string): void {
  try {
    sessionStorage.setItem(`${KEY_PREFIX}${sessionId}`, text);
  } catch {
    // 存储不可用：不预填
  }
}

export function consumeComposerPrefill(sessionId: string): string | null {
  try {
    const key = `${KEY_PREFIX}${sessionId}`;
    const value = sessionStorage.getItem(key);
    if (value !== null) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}
