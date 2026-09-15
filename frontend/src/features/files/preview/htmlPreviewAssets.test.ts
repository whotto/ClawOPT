// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableCSSFileLoading": true, "disableJavaScriptFileLoading": true, "disableJavaScriptEvaluation": true, "disableIframePageLoading": true, "navigation": { "disableMainFrameNavigation": true, "disableChildFrameNavigation": true, "disableChildPageNavigation": true } } }
import { describe, expect, it } from 'vitest';
import { HTML_PREVIEW_MAX_IMAGE_BYTES, resolveHtmlPreviewAssetUrl, resolveHtmlPreviewImages } from './htmlPreviewAssets';

const ORIGIN = 'http://localhost:3105';
const ENTRY = '/api/files/html-preview/path/QUJD/__claw_preview_root__/__claw_preview_root__/index.html';

describe('resolveHtmlPreviewAssetUrl', () => {
  it('resolves relative paths under the html-preview route only', () => {
    expect(resolveHtmlPreviewAssetUrl(ENTRY, 'img/a.png', ORIGIN)).toBe('/api/files/html-preview/path/QUJD/__claw_preview_root__/__claw_preview_root__/img/a.png');
    expect(resolveHtmlPreviewAssetUrl(ENTRY, '../../../../../../x.png', ORIGIN)).toBeNull();
    expect(resolveHtmlPreviewAssetUrl(ENTRY, 'https://evil.example/x.png', ORIGIN)).toBeNull();
  });
});

describe('resolveHtmlPreviewImages', () => {
  it('fetches only same-route images, skips non-images and oversized ones, and revokes blob URLs', async () => {
    const fetched: string[] = [];
    const revoked: string[] = [];
    let counter = 0;
    const result = await resolveHtmlPreviewImages('<img src="a.png"><img src="page.html"><img src="big.png"><img src="https://x/y.png">', ENTRY, {
      origin: ORIGIN,
      fetchImpl: async (url) => {
        fetched.push(url);
        if (url.endsWith('page.html')) return new Response('<p>', { headers: { 'content-type': 'text/html' } });
        if (url.endsWith('big.png')) return new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(HTML_PREVIEW_MAX_IMAGE_BYTES + 1) } });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
      },
      createObjectUrl: () => `blob:${ORIGIN}/${++counter}`,
      revokeObjectUrl: (url) => revoked.push(url),
    });
    expect(fetched.every((url) => url.startsWith('/api/files/html-preview/'))).toBe(true);
    expect([...result.sources.entries()]).toEqual([['a.png', `blob:${ORIGIN}/1`]]);
    expect(result.skipped).toBe(2);
    result.revoke();
    expect(revoked).toEqual([`blob:${ORIGIN}/1`]);
  });

  it('does nothing without an entry URL', async () => {
    const result = await resolveHtmlPreviewImages('<img src="a.png">', null, { origin: ORIGIN, fetchImpl: async () => { throw new Error('should not fetch'); } });
    expect(result.sources.size).toBe(0);
  });
});
