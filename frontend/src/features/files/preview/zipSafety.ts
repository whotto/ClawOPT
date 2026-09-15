/**
 * OOXML（DOCX / PPTX / XLSX）渲染前的 ZIP 炸弹预检（spec 01 §2.23）。
 *
 * 只读中央目录，不解压任何内容：条目数、每个条目声明的解压后大小、总大小、多卷、ZIP64、结构自洽。
 * 渲染库（mammoth、xlsx）会把整个包解压进内存，一个几百 KB 的炸弹就能把标签页撑崩——必须在交给它们之前挡住。
 *
 * 局限（写明，不假装）：中央目录里声明的大小可以撒谎。这里另加「单条目压缩比」上限挡住最常见的高压缩比炸弹，
 * 对「声明小、实际大」的伪造包，XLSX / CSV 的解析跑在 Worker 里、有超时并会被终止，DOCX 目前仍在主线程（见报告 TODO）。
 */

export type ZipSafetyReason =
  | 'notZip'
  | 'truncated'
  | 'multiDisk'
  | 'zip64'
  | 'tooManyEntries'
  | 'entryTooLarge'
  | 'totalTooLarge'
  | 'suspiciousRatio'
  | 'inconsistent';

export type ZipSafetyLimits = {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  /** 单条目解压后 / 压缩后的上限（deflate 理论极限约 1032:1）。 */
  maxCompressionRatio: number;
};

export const DEFAULT_ZIP_SAFETY_LIMITS: ZipSafetyLimits = Object.freeze({
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 128 * 1024 * 1024,
  maxCompressionRatio: 1000,
});

export type ZipSafetyVerdict =
  | { ok: true; entries: number; totalUncompressedBytes: number }
  | { ok: false; reason: ZipSafetyReason };

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;

/** 以 `PK\x03\x04` 开头（本地文件头）。老格式 .doc / .xls 不是 ZIP，调用方据此决定要不要预检。 */
export function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const view = new DataView(buffer);
  return view.getUint32(0, true) === 0x04034b50;
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = view.byteLength - EOCD_MIN_LENGTH; offset >= lowest; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

export function inspectZipArchive(buffer: ArrayBuffer, limits: ZipSafetyLimits = DEFAULT_ZIP_SAFETY_LIMITS): ZipSafetyVerdict {
  if (buffer.byteLength < EOCD_MIN_LENGTH) return { ok: false, reason: 'notZip' };
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) return { ok: false, reason: 'notZip' };

  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_EOCD_LOCATOR_SIGNATURE) return { ok: false, reason: 'zip64' };

  const diskNumber = view.getUint16(eocd + 4, true);
  const centralDirectoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralDirectorySize = view.getUint32(eocd + 12, true);
  const centralDirectoryOffset = view.getUint32(eocd + 16, true);

  if (totalEntries === 0xffff || entriesOnDisk === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    return { ok: false, reason: 'zip64' };
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) return { ok: false, reason: 'multiDisk' };
  if (totalEntries > limits.maxEntries) return { ok: false, reason: 'tooManyEntries' };
  if (centralDirectoryOffset + centralDirectorySize > eocd) return { ok: false, reason: 'truncated' };

  let cursor = centralDirectoryOffset;
  let walked = 0;
  let total = 0;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (cursor < end) {
    if (cursor + 46 > end) return { ok: false, reason: 'truncated' };
    if (view.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) return { ok: false, reason: 'inconsistent' };
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) return { ok: false, reason: 'truncated' };

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || diskStart === 0xffff) {
      return { ok: false, reason: 'zip64' };
    }
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const size = view.getUint16(extra + 2, true);
      if (id === ZIP64_EXTRA_FIELD_ID) return { ok: false, reason: 'zip64' };
      extra += 4 + size;
    }
    if (diskStart !== 0) return { ok: false, reason: 'multiDisk' };
    if (localHeaderOffset >= centralDirectoryOffset) return { ok: false, reason: 'inconsistent' };
    if (uncompressedSize > limits.maxEntryUncompressedBytes) return { ok: false, reason: 'entryTooLarge' };
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) return { ok: false, reason: 'suspiciousRatio' };
    if (compressedSize === 0 && uncompressedSize > 0) return { ok: false, reason: 'inconsistent' };
    total += uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) return { ok: false, reason: 'totalTooLarge' };

    walked += 1;
    if (walked > limits.maxEntries) return { ok: false, reason: 'tooManyEntries' };
    cursor = next;
  }

  if (walked !== totalEntries) return { ok: false, reason: 'inconsistent' };
  return { ok: true, entries: walked, totalUncompressedBytes: total };
}
