import { describe, expect, it } from 'vitest';
import { DEFAULT_ZIP_SAFETY_LIMITS, inspectZipArchive, looksLikeZip } from './zipSafety';

type Entry = { name: string; data: Uint8Array; declaredUncompressed?: number; declaredCompressed?: number; extra?: Uint8Array };

/** 最小的「存储」（不压缩）ZIP 构造器，只为造测试包：可以篡改中央目录里声明的大小与 EOCD 字段。 */
function buildZip(entries: Entry[], eocdOverrides: Partial<{ disk: number; cdDisk: number; entriesOnDisk: number; totalEntries: number }> = {}, options: { zip64Locator?: boolean } = {}): ArrayBuffer {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    locals.push(local);

    const extra = entry.extra ?? new Uint8Array();
    const central = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, entry.declaredCompressed ?? entry.data.length, true);
    cv.setUint32(24, entry.declaredUncompressed ?? entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    central.set(extra, 46 + name.length);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const locator = options.zip64Locator ? new Uint8Array(20) : new Uint8Array();
  if (options.zip64Locator) new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, eocdOverrides.disk ?? 0, true);
  ev.setUint16(6, eocdOverrides.cdDisk ?? 0, true);
  ev.setUint16(8, eocdOverrides.entriesOnDisk ?? entries.length, true);
  ev.setUint16(10, eocdOverrides.totalEntries ?? entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + cdSize + locator.length + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...locals, ...centrals, locator, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const MB = 1024 * 1024;

describe('inspectZipArchive', () => {
  it('accepts a normal small package', () => {
    const zip = buildZip([{ name: '[Content_Types].xml', data: bytes('<Types/>') }, { name: 'word/document.xml', data: bytes('<w:document/>') }]);
    expect(looksLikeZip(zip)).toBe(true);
    expect(inspectZipArchive(zip)).toEqual({ ok: true, entries: 2, totalUncompressedBytes: 21 });
  });

  it('rejects non-zip bytes', () => {
    const plain = bytes('this is not a zip archive at all, definitely not').buffer as ArrayBuffer;
    expect(looksLikeZip(plain)).toBe(false);
    expect(inspectZipArchive(plain)).toEqual({ ok: false, reason: 'notZip' });
  });

  it('rejects too many entries (declared and walked)', () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}`, data: bytes('x') }));
    expect(inspectZipArchive(buildZip(entries), { ...DEFAULT_ZIP_SAFETY_LIMITS, maxEntries: 10 })).toEqual({ ok: false, reason: 'tooManyEntries' });
    // 目录头声明的条目数超限时，不必逐条走完就拒绝。
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a') }], { entriesOnDisk: 20_000, totalEntries: 20_000 }))).toEqual({ ok: false, reason: 'tooManyEntries' });
  });

  it('rejects an entry that declares more than the per-entry limit', () => {
    const zip = buildZip([{ name: 'xl/sheet1.xml', data: bytes('abcd'.repeat(1000)), declaredUncompressed: 65 * MB, declaredCompressed: 1 * MB }]);
    expect(inspectZipArchive(zip)).toEqual({ ok: false, reason: 'entryTooLarge' });
  });

  it('rejects when declared sizes add up past the total limit', () => {
    const entries = [0, 1, 2].map((i) => ({ name: `part${i}`, data: bytes('x'), declaredUncompressed: 50 * MB, declaredCompressed: 1 * MB }));
    expect(inspectZipArchive(buildZip(entries))).toEqual({ ok: false, reason: 'totalTooLarge' });
  });

  it('rejects abnormally high compression ratios', () => {
    const zip = buildZip([{ name: 'bomb.xml', data: bytes('x'), declaredUncompressed: 10 * MB, declaredCompressed: 1000 }]);
    expect(inspectZipArchive(zip)).toEqual({ ok: false, reason: 'suspiciousRatio' });
  });

  it('rejects ZIP64 via locator, sentinel sizes and extra field', () => {
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a') }], {}, { zip64Locator: true }))).toEqual({ ok: false, reason: 'zip64' });
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a'), declaredUncompressed: 0xffffffff }]))).toEqual({ ok: false, reason: 'zip64' });
    const extra = new Uint8Array(4 + 8);
    new DataView(extra.buffer).setUint16(0, 0x0001, true);
    new DataView(extra.buffer).setUint16(2, 8, true);
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a'), extra }]))).toEqual({ ok: false, reason: 'zip64' });
  });

  it('rejects multi-disk archives', () => {
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a') }], { disk: 1 }))).toEqual({ ok: false, reason: 'multiDisk' });
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a') }, { name: 'b', data: bytes('b') }], { entriesOnDisk: 1 }))).toEqual({ ok: false, reason: 'multiDisk' });
  });

  it('rejects a directory whose entry count disagrees with the records', () => {
    expect(inspectZipArchive(buildZip([{ name: 'a', data: bytes('a') }], { entriesOnDisk: 3, totalEntries: 3 }))).toEqual({ ok: false, reason: 'inconsistent' });
  });

  it('rejects a truncated package', () => {
    const zip = buildZip([{ name: 'a', data: bytes('abc') }]);
    const cut = zip.slice(0, zip.byteLength - 10);
    expect(inspectZipArchive(cut).ok).toBe(false);
  });
});
