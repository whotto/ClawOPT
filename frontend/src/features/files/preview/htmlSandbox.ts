/**
 * HTML 文件预览的消毒与沙箱文档（spec 01 §2.23）。
 *
 * 预览的 HTML 往往是 Agent 写进工作区的产物，内容不可信。三层防线，缺一层都不算安全：
 * 1. **DOM 消毒**（这里）：删掉会执行、会发请求、会跳转、会提交的元素与属性；
 * 2. **严格 CSP**（这里注入的 `<meta>`）：即使消毒漏了，也不能执行脚本、不能联网、不能嵌框、不能提交表单；
 * 3. **空 `sandbox` 的 iframe + `srcdoc`**（`HtmlFrameViewer`）：不透明源、无脚本、无表单、无弹窗，
 *    不和 ClawOPT 同源，读不到登录 cookie 与接口。
 *
 * 此前的做法是把 HTML 从同源地址加载进 `allow-scripts allow-forms allow-popups` 的 iframe——
 * 脚本照跑、可以向任意地址发请求、可以弹窗钓鱼。
 *
 * 相对路径的图片（`<img src="img/a.png">`）由调用方先经鉴权接口取成 blob: 地址，按原值传进来替换；
 * 其余一切非 data: / blob: 的地址一律删掉，不留给浏览器去请求。
 */

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** 整个删掉的元素（连同子树）。 */
const FORBIDDEN_ELEMENTS = [
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'link', 'meta', 'portal',
];

/** 带地址、会导航 / 提交 / 请求的属性：一律删（`src` 单独处理，data: / blob: 保留）。 */
const URL_ATTRIBUTES = new Set([
  'href', 'xlink:href', 'action', 'formaction', 'srcset', 'imagesrcset', 'ping', 'background', 'poster',
  'data', 'codebase', 'longdesc', 'lowsrc', 'dynsrc', 'manifest', 'srcdoc', 'archive', 'classid', 'usemap',
]);

const SRC_ATTRIBUTES = new Set(['src']);

export type HtmlSandboxResult = {
  html: string;
  removedElements: number;
  removedAttributes: number;
};

export type HtmlSandboxOptions = {
  /** 原始 `src` 值 → 已取好的 blob: 地址（只用于相对路径的图片）。 */
  resolvedSources?: ReadonlyMap<string, string>;
  /** 测试注入；缺省用浏览器的 DOMParser。 */
  parser?: Pick<DOMParser, 'parseFromString'>;
};

function isInlineUrl(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('data:') || trimmed.startsWith('blob:');
}

/**
 * CSS 里能发请求或执行的部分：`@import`、指向非 data: 的 `url()`、IE 的 `expression()` / `behavior`、
 * Firefox 的 `-moz-binding`。CSP 本来也挡网络，这里再删一遍，免得 CSP 被某个浏览器实现漏掉。
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, _quote, inner: string) => (isInlineUrl(inner) ? match : 'none'))
    .replace(/expression\s*\(/gi, 'invalid(')
    .replace(/-moz-binding\s*:/gi, 'invalid:')
    .replace(/behavior\s*:/gi, 'invalid:');
}

/** 相对路径图片的原始 `src`（调用方据此去取 blob）。去重、保持出现顺序。 */
export function collectRelativeImageSources(source: string, parser: Pick<DOMParser, 'parseFromString'> = new DOMParser()): string[] {
  const doc = parser.parseFromString(source, 'text/html');
  const out: string[] = [];
  doc.querySelectorAll('img[src], source[src]').forEach((node) => {
    const value = (node.getAttribute('src') || '').trim();
    if (!value || isInlineUrl(value)) return;
    // 协议相对、绝对地址与带 scheme 的地址不是工作区里的文件，不去取。
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('/')) return;
    if (!out.includes(value)) out.push(value);
  });
  return out;
}

export function buildSandboxedHtmlDocument(source: string, options: HtmlSandboxOptions = {}): HtmlSandboxResult {
  const parser = options.parser ?? new DOMParser();
  const doc = parser.parseFromString(source, 'text/html');
  let removedElements = 0;
  let removedAttributes = 0;

  for (const tag of FORBIDDEN_ELEMENTS) {
    doc.querySelectorAll(tag).forEach((node) => {
      node.remove();
      removedElements += 1;
    });
  }

  doc.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || URL_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name);
        removedAttributes += 1;
        continue;
      }
      if (SRC_ATTRIBUTES.has(name)) {
        if (isInlineUrl(attribute.value)) continue;
        const resolved = options.resolvedSources?.get(attribute.value.trim());
        if (resolved && isInlineUrl(resolved)) {
          element.setAttribute(attribute.name, resolved);
          continue;
        }
        element.removeAttribute(attribute.name);
        removedAttributes += 1;
        continue;
      }
      if (name === 'style') {
        const cleaned = sanitizeCss(attribute.value);
        if (cleaned !== attribute.value) element.setAttribute(attribute.name, cleaned);
      }
    }
  });

  doc.querySelectorAll('style').forEach((style) => {
    const text = style.textContent || '';
    const cleaned = sanitizeCss(text);
    if (cleaned !== text) style.textContent = cleaned;
  });

  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', HTML_PREVIEW_CSP);
  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  // CSP 必须在任何可能引用资源的节点之前生效，所以放在 head 最前面。
  head.insertBefore(charset, head.firstChild);
  head.insertBefore(csp, head.firstChild);

  return {
    html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`,
    removedElements,
    removedAttributes,
  };
}

/** iframe 的 sandbox 属性：空串 = 全部限制（无脚本、无表单、无弹窗、不透明源）。 */
export const HTML_PREVIEW_SANDBOX = '';
