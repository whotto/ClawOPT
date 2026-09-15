/// <reference types="vite/client" />
// 首帧主题脚本（public/theme-boot.js）：挂载前就按本机缓存打好属性；缓存被改坏不注入任何东西。
import { describe, expect, it } from 'vitest';
import SOURCE from '../../public/theme-boot.js?raw';
import { THEME_CACHE_KEY } from './themeRuntime';

type FakeElement = {
  attrs: Map<string, string>;
  vars: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
};

function boot(cache: unknown, options: { prefersDark?: boolean; storageThrows?: boolean } = {}) {
  const attrs = new Map<string, string>();
  const vars = new Map<string, string>();
  const el: FakeElement = {
    attrs,
    vars,
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: (name) => attrs.delete(name),
    getAttribute: (name) => attrs.get(name) ?? null,
    style: { setProperty: (name, value) => vars.set(name, value), removeProperty: (name) => vars.delete(name) },
  };
  const listeners: Array<() => void> = [];
  const win: Record<string, unknown> = {
    document: { documentElement: el },
    localStorage: {
      getItem: (key: string) => {
        if (options.storageThrows) throw new Error('denied');
        return key === THEME_CACHE_KEY && cache !== undefined ? (typeof cache === 'string' ? cache : JSON.stringify(cache)) : null;
      },
    },
    matchMedia: () => ({ matches: Boolean(options.prefersDark), addEventListener: (_: string, fn: () => void) => listeners.push(fn) }),
  };
  // 与浏览器里一样：脚本拿全局 window 执行。
  new Function('window', 'globalThis', SOURCE)(win, win);
  return { el, win, listeners };
}

describe('theme-boot.js', () => {
  it('没有缓存：浅色、不带任何自定义属性', () => {
    const { el } = boot(undefined);
    expect(el.getAttribute('data-theme-mode')).toBe('light');
    expect([...el.attrs.keys()].sort()).toEqual(['data-theme-mode', 'data-theme-preference']);
    expect(el.vars.size).toBe(0);
  });

  it('缓存的深色 + 强调色 + 文字色 + 字号 + 背景：首帧前全部生效', () => {
    const { el } = boot({ userKey: 'u:7', theme: { mode: 'dark', accentColor: '#ff8800', textColor: '#112233', fontSize: 18, background: { revision: 'abc123' } } });
    expect(el.getAttribute('data-theme-mode')).toBe('dark');
    expect(el.vars.get('--theme-accent')).toBe('#ff8800');
    expect(el.vars.get('--theme-text')).toBe('#112233');
    expect(el.vars.get('--theme-font-size')).toBe('18px');
    expect(el.vars.get('--theme-bg-image')).toBe('url("/api/theme/background?v=abc123")');
    for (const attr of ['data-theme-accent', 'data-theme-text', 'data-theme-font', 'data-theme-bg']) expect(el.attrs.has(attr), attr).toBe(true);
  });

  it('跟随系统：按 prefers-color-scheme 解析，偏好本身另记', () => {
    const { el } = boot({ userKey: 'u:1', theme: { mode: 'system' } }, { prefersDark: true });
    expect(el.getAttribute('data-theme-mode')).toBe('dark');
    expect(el.getAttribute('data-theme-preference')).toBe('system');
  });

  it('被改坏的缓存不注入：颜色 / 字号 / 背景版本号都按白名单形状判', () => {
    const { el } = boot({
      userKey: 'u:1',
      theme: {
        mode: 'dark;}body{display:none',
        accentColor: 'red;} body { background: url(//evil) }',
        textColor: 'expression(alert(1))',
        fontSize: '18px; }',
        background: { revision: '1") ; } :root{--x:url("//evil' },
      },
    });
    expect(el.getAttribute('data-theme-mode')).toBe('light');
    expect(el.vars.size).toBe(0);
    expect(el.attrs.has('data-theme-bg')).toBe(false);
  });

  it('本机存储不可用（隐私模式）与 JSON 损坏：默认主题，不抛', () => {
    expect(boot(undefined, { storageThrows: true }).el.getAttribute('data-theme-mode')).toBe('light');
    expect(boot('{not json').el.getAttribute('data-theme-mode')).toBe('light');
  });

  it('React 侧与首帧用同一个 apply：再次应用默认主题会清掉自定义变量', () => {
    const { el, win } = boot({ userKey: 'u:7', theme: { mode: 'dark', accentColor: '#ff8800' } });
    (win.__clawoptApplyTheme as (theme: unknown, w: unknown) => void)({ mode: 'light' }, win);
    expect(el.getAttribute('data-theme-mode')).toBe('light');
    expect(el.vars.size).toBe(0);
    expect(win.__clawoptThemeCacheKey).toBe(THEME_CACHE_KEY);
  });
});
