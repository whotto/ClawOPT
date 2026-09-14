import { describe, expect, it } from 'vitest';
import { buildPreviewDataUrl, buildPreviewUrl, getDefaultViewMode, getFileType, isLibreOfficeHintRelevant } from './previewUtils';

describe('getFileType', () => {
  it('classifies by extension, ignoring query and hash', () => {
    expect(getFileType('a.PNG')).toBe('image');
    expect(getFileType('report.docx?v=2')).toBe('docx');
    expect(getFileType('notes.md#top')).toBe('text');
    expect(getFileType('main.tsx')).toBe('code');
    expect(getFileType('archive.zip')).toBe('unknown');
  });

  it('flags office formats that need LibreOffice', () => {
    expect(isLibreOfficeHintRelevant('pptx')).toBe(true);
    expect(isLibreOfficeHintRelevant('pdf')).toBe(false);
  });
});

describe('getDefaultViewMode', () => {
  it('renders markdown and html, shows source otherwise', () => {
    expect(getDefaultViewMode('a.md')).toBe('render');
    expect(getDefaultViewMode('a.HTML')).toBe('render');
    expect(getDefaultViewMode('a.txt')).toBe('source');
  });
});

describe('preview url builders', () => {
  it('maps download links and uploads to preview endpoints', () => {
    expect(buildPreviewUrl('/api/files/download?path=abc%3D')).toBe('/api/files/preview?path=abc%3D&mode=source');
    expect(buildPreviewUrl('/uploads/a%20b.txt')).toBe('/api/files/preview?filename=a%20b.txt&mode=source');
    expect(buildPreviewUrl('https://x.test/f.txt')).toBe('https://x.test/f.txt');
    expect(buildPreviewDataUrl('/uploads/a.pdf', 'converted')).toBe('/api/files/preview-data?filename=a.pdf&mode=converted');
    expect(buildPreviewDataUrl('https://x.test/f.pdf')).toBeNull();
  });
});
