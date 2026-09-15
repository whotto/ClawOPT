/*
 * 主题首帧（P6）：在 React 挂载之前、样式表之后同步执行，按本机缓存的「当前用户主题」给 <html> 打上属性与 CSS 变量，
 * 首帧就是用户的明暗、强调色、文字色、字号与背景，不闪一下默认主题。
 *
 * 这是**唯一一份**「主题 → 根元素属性」的实现：React 侧（src/theme/themeRuntime.ts）保存后调用同一个
 * `window.__clawoptApplyTheme`，测试（src/theme/themeBoot.test.ts）也直接加载这个文件——两边不许各写一份。
 *
 * 只认白名单形状：颜色必须是 #rrggbb、字号 12–20 的整数、模式三选一；缓存被改坏就当没有缓存。
 */
(function (root) {
  var CACHE_KEY = 'clawopt.theme.v1';
  var HEX = /^#[0-9a-f]{6}$/;
  var MODES = { light: 1, dark: 1, system: 1 };

  function sanitize(theme) {
    if (!theme || typeof theme !== 'object') return null;
    var mode = MODES[theme.mode] ? theme.mode : 'light';
    var accent = typeof theme.accentColor === 'string' && HEX.test(theme.accentColor) ? theme.accentColor : null;
    var text = typeof theme.textColor === 'string' && HEX.test(theme.textColor) ? theme.textColor : null;
    var font = typeof theme.fontSize === 'number' && theme.fontSize % 1 === 0 && theme.fontSize >= 12 && theme.fontSize <= 20 ? theme.fontSize : null;
    var bg = theme.background && typeof theme.background.revision === 'string' && /^[0-9a-f]{1,64}$/.test(theme.background.revision) ? theme.background.revision : null;
    return { mode: mode, accentColor: accent, textColor: text, fontSize: font, backgroundRevision: bg };
  }

  function prefersDark(win) {
    try {
      return Boolean(win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (error) {
      return false;
    }
  }

  function apply(theme, win) {
    win = win || root;
    var doc = win.document;
    var el = doc && doc.documentElement;
    if (!el) return null;
    var clean = sanitize(theme) || { mode: 'light', accentColor: null, textColor: null, fontSize: null, backgroundRevision: null };
    var resolved = clean.mode === 'system' ? (prefersDark(win) ? 'dark' : 'light') : clean.mode;
    el.setAttribute('data-theme-mode', resolved);
    el.setAttribute('data-theme-preference', clean.mode);
    var style = el.style;
    function toggle(attr, variable, value) {
      if (value === null) {
        el.removeAttribute(attr);
        style.removeProperty(variable);
      } else {
        el.setAttribute(attr, '');
        style.setProperty(variable, value);
      }
    }
    toggle('data-theme-accent', '--theme-accent', clean.accentColor);
    toggle('data-theme-text', '--theme-text', clean.textColor);
    toggle('data-theme-font', '--theme-font-size', clean.fontSize === null ? null : clean.fontSize + 'px');
    toggle('data-theme-bg', '--theme-bg-image', clean.backgroundRevision === null ? null : 'url("/api/theme/background?v=' + clean.backgroundRevision + '")');
    return { resolvedMode: resolved, theme: clean };
  }

  function readCache(win) {
    try {
      var raw = win.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
      return null;
    }
  }

  root.__clawoptApplyTheme = apply;
  root.__clawoptThemeCacheKey = CACHE_KEY;
  var cached = readCache(root);
  apply(cached ? cached.theme : null, root);
  // 跟随系统：系统切换明暗时立刻跟上（用户主题由 React 侧更新缓存后再调 apply）。
  try {
    var media = root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)');
    if (media && media.addEventListener) {
      media.addEventListener('change', function () {
        var current = readCache(root);
        apply(current ? current.theme : null, root);
      });
    }
  } catch (error) {
    /* 老浏览器没有 addEventListener：只在下次加载时跟上。 */
  }
})(typeof window !== 'undefined' ? window : globalThis);
