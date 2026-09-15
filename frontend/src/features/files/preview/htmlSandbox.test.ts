// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "disableJavaScriptEvaluation": true, "disableIframePageLoading": true, "navigation": { "disableMainFrameNavigation": true, "disableChildFrameNavigation": true, "disableChildPageNavigation": true } } }
import { describe, expect, it } from 'vitest';
import { buildSandboxedHtmlDocument, collectRelativeImageSources, HTML_PREVIEW_CSP, HTML_PREVIEW_SANDBOX, sanitizeCss } from './htmlSandbox';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('buildSandboxedHtmlDocument', () => {
  const hostile = `<!doctype html><html><head>
    <meta http-equiv="refresh" content="0;url=https://evil.example/">
    <base href="https://evil.example/">
    <link rel="stylesheet" href="https://evil.example/x.css">
    <style>@import url("https://evil.example/a.css"); body { background: url(https://evil.example/bg.png); } .ok { background: url(data:image/png;base64,AAAA); }</style>
    <script>window.parent.document.cookie</script>
  </head><body onload="steal()">
    <h1 onclick="x()">Title</h1>
    <a href="javascript:alert(1)">link</a>
    <img src="https://evil.example/track.png" srcset="https://evil.example/a.png 2x" onerror="x()">
    <img src="data:image/png;base64,AAAA" alt="inline">
    <img src="img/local.png" alt="relative">
    <form action="https://evil.example/post"><input name="p"><button formaction="https://evil.example/b">go</button></form>
    <iframe src="https://evil.example/"></iframe><object data="x.swf"></object><embed src="x.swf">
    <svg><a xlink:href="javascript:alert(1)"><text>svg</text></a></svg>
    <div style="background-image:url('https://evil.example/c.png')">styled</div>
  </body></html>`;

  it('removes executable, navigating, submitting and network-bound markup', () => {
    const { html, removedElements, removedAttributes } = buildSandboxedHtmlDocument(hostile);
    const doc = parse(html);
    expect(doc.querySelectorAll('script, iframe, object, embed, form, base, link').length).toBe(0);
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    const all = Array.from(doc.querySelectorAll('*'));
    for (const element of all) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.toLowerCase().startsWith('on')).toBe(false);
        expect(['href', 'xlink:href', 'srcset', 'action', 'formaction']).not.toContain(attribute.name.toLowerCase());
      }
    }
    const srcs = Array.from(doc.querySelectorAll('[src]')).map((node) => node.getAttribute('src'));
    expect(srcs).toEqual(['data:image/png;base64,AAAA']);
    expect(html).not.toContain('evil.example');
    expect(html).toContain('url(data:image/png;base64,AAAA)');
    expect(doc.querySelector('h1')?.textContent).toBe('Title');
    expect(removedElements).toBeGreaterThan(0);
    expect(removedAttributes).toBeGreaterThan(0);
  });

  it('injects the strict CSP as the first node of <head>', () => {
    const doc = parse(buildSandboxedHtmlDocument('<p>hi</p>').html);
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(HTML_PREVIEW_CSP);
    expect(HTML_PREVIEW_CSP).toContain("default-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("script-src 'none'");
    expect(HTML_PREVIEW_CSP).toContain("form-action 'none'");
    expect(HTML_PREVIEW_CSP).not.toMatch(/https?:|'self'|unsafe-eval/);
  });

  it('replaces relative image sources only with the blob URLs the caller resolved', () => {
    const resolved = new Map([['img/local.png', 'blob:http://localhost/abc'], ['img/evil.png', 'https://evil.example/x.png']]);
    const doc = parse(buildSandboxedHtmlDocument('<img src="img/local.png"><img src="img/evil.png"><img src="img/missing.png">', { resolvedSources: resolved }).html);
    expect(Array.from(doc.querySelectorAll('img')).map((img) => img.getAttribute('src'))).toEqual(['blob:http://localhost/abc', null, null]);
  });

  it('uses a fully restrictive iframe sandbox', () => {
    expect(HTML_PREVIEW_SANDBOX).toBe('');
  });
});

describe('sanitizeCss', () => {
  it('drops @import, remote url(), expression() and bindings', () => {
    const cleaned = sanitizeCss("@import 'x.css'; a{background:url(\"//evil/x\")} b{width:expression(alert(1))} c{-moz-binding:url(x)} d{behavior:url(x.htc)} e{background:url(data:image/gif;base64,R0)}");
    expect(cleaned).not.toContain('@import');
    expect(cleaned).not.toContain('//evil');
    expect(cleaned).not.toMatch(/expression\s*\(/);
    expect(cleaned).not.toContain('-moz-binding:');
    expect(cleaned).not.toMatch(/behavior\s*:/);
    expect(cleaned).toContain('url(data:image/gif;base64,R0)');
  });
});

describe('collectRelativeImageSources', () => {
  it('lists workspace-relative images once and ignores absolute, scheme and inline sources', () => {
    expect(collectRelativeImageSources('<img src="a.png"><img src="./b/c.png"><img src="a.png"><img src="/etc/x.png"><img src="https://x/y.png"><img src="//cdn/z.png"><img src="data:image/png;base64,AA">'))
      .toEqual(['a.png', './b/c.png']);
  });
});
