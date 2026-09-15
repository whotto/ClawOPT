/**
 * 文本去重拼接。
 *
 * 有些 CLI 时而推增量、时而推累计快照；两路都收文本时（代理增量 + CLI 终文）同一段话还会来两遍。
 * 规则：
 * 1. 新块以已累计文本开头 → 只取多出来的后缀；
 * 2. 否则找「已累计文本的尾部」与「新块的头部」最长重叠（至少 16 个字符），去掉重叠部分；
 * 3. 短于 16 个字符的块一律当真增量——短块的偶然重叠太常见（「的」「。」「\n」），按重叠去掉会吃字。
 */
export const TEXT_DEDUPE_MIN_OVERLAP = 16;

export function dedupeAppendedText(accumulated: string, chunk: string): string {
  if (!chunk) return '';
  if (chunk.length < TEXT_DEDUPE_MIN_OVERLAP) return chunk;
  if (accumulated && chunk.startsWith(accumulated)) return chunk.slice(accumulated.length);

  const maxOverlap = Math.min(accumulated.length, chunk.length);
  for (let size = maxOverlap; size >= TEXT_DEDUPE_MIN_OVERLAP; size -= 1) {
    if (accumulated.endsWith(chunk.slice(0, size))) return chunk.slice(size);
  }
  return chunk;
}
