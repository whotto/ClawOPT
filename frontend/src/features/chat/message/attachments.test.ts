import { describe, expect, it } from 'vitest';
import { parseAttachmentsFromContent, parseStandaloneEmbedPreviews } from './attachments';
import { normalizeNavigableHref } from './links';

describe('parseAttachmentsFromContent', () => {
  it('extracts upload images and file links and removes them from text', () => {
    const result = parseAttachmentsFromContent('look ![shot](/uploads/a.png)\n\n\n\n[doc](/api/files/view?x=1) done');
    expect(result.attachments).toEqual([
      { name: 'shot', url: '/uploads/a.png', isImage: true },
      { name: 'doc', url: '/api/files/view?x=1', isImage: false },
    ]);
    expect(result.text).toBe('look \n\n done');
  });

  it('leaves external links, download links and fenced code alone', () => {
    const content = '[site](https://a.test) [dl](/api/files/download?path=abc)\n```\n![x](/uploads/in-code.png)\n```';
    expect(parseAttachmentsFromContent(content)).toEqual({ attachments: [], text: content });
  });

  it('uses default names when link text is empty', () => {
    expect(parseAttachmentsFromContent('![](/uploads/a.png)[](/uploads/b.txt)').attachments).toEqual([
      { name: 'image', url: '/uploads/a.png', isImage: true },
      { name: 'file', url: '/uploads/b.txt', isImage: false },
    ]);
  });
});

describe('parseStandaloneEmbedPreviews', () => {
  it('parses a message made only of embed tags and scales the height', () => {
    expect(parseStandaloneEmbedPreviews('[embed url="https://a.test/x" title="Demo" height="600"]')).toEqual([
      { url: 'https://a.test/x', title: 'Demo', height: 300 },
    ]);
  });

  it('rejects embeds mixed with other text', () => {
    expect(parseStandaloneEmbedPreviews('hi [embed url="https://a.test"]')).toEqual([]);
  });
});

describe('normalizeNavigableHref', () => {
  it('accepts http(s) and bare hosts, rejects other schemes', () => {
    expect(normalizeNavigableHref('https://a.test/p')).toBe('https://a.test/p');
    expect(normalizeNavigableHref('example.com/x')).toBe('http://example.com/x');
    expect(normalizeNavigableHref('javascript:alert(1)')).toBeNull();
    expect(normalizeNavigableHref('  ')).toBeNull();
  });
});
