/**
 * 按**字节**封顶的环形输出缓冲（spec 07 §2.7 的缺陷之一：参考实现按「块数」封顶，一行巨输出就能撑爆内存）。
 *
 * 偏移是整个会话生命周期里单调递增的字节序号：`start` = 缓冲里第一个字节的序号，`end` = 下一个字节的序号。
 * 接回时客户端带上自己已经写到的 `sinceOffset`，服务端只补差额；差额早于 `start`（被挤掉了）时整段重放并标 `truncated`。
 *
 * 裁剪时不从 UTF-8 多字节字符中间切：起点前移到下一个字符边界，重放出来的永远是合法文本。
 */
export const DEFAULT_TERMINAL_BUFFER_BYTES = 1024 * 1024;

export type RingBufferSlice = { data: string; start: number; end: number; truncated: boolean };

export class ByteRingBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private startOffset = 0;

  constructor(readonly capacityBytes: number = DEFAULT_TERMINAL_BUFFER_BYTES) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 16) throw new Error('ring buffer capacity too small');
  }

  get start(): number {
    return this.startOffset;
  }

  get end(): number {
    return this.startOffset + this.size;
  }

  get byteLength(): number {
    return this.size;
  }

  /** 追加一段输出，返回追加后的 `end`。 */
  append(text: string | Buffer): number {
    let bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
    if (bytes.length === 0) return this.end;
    if (bytes.length > this.capacityBytes) {
      // 单块就超过容量：只留尾部，丢掉的部分计入偏移。
      const drop = bytes.length - this.capacityBytes;
      this.startOffset += this.size + drop;
      this.chunks = [];
      this.size = 0;
      bytes = bytes.subarray(drop);
    }
    this.chunks.push(bytes);
    this.size += bytes.length;
    this.trim();
    return this.end;
  }

  private trim(): void {
    let excess = this.size - this.capacityBytes;
    while (excess > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
        this.startOffset += first.length;
        excess -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
        this.startOffset += excess;
        excess = 0;
      }
    }
    // 起点落在 UTF-8 续字节上：前移到字符边界。
    while (this.chunks.length > 0) {
      const first = this.chunks[0];
      let skip = 0;
      while (skip < first.length && skip < 3 && (first[skip] & 0xc0) === 0x80) skip += 1;
      if (skip === 0) break;
      if (skip >= first.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(skip);
      }
      this.size -= Math.min(skip, first.length);
      this.startOffset += Math.min(skip, first.length);
      if (skip < first.length) break;
    }
  }

  /** 从 `sinceOffset` 起的内容；不给或早于缓冲起点时从头给并标 truncated（给了且早于起点才算 truncated）。 */
  sliceFrom(sinceOffset?: number | null): RingBufferSlice {
    const all = Buffer.concat(this.chunks, this.size);
    const end = this.end;
    if (typeof sinceOffset !== 'number' || !Number.isFinite(sinceOffset)) {
      return { data: all.toString('utf8'), start: this.startOffset, end, truncated: false };
    }
    if (sinceOffset >= end) return { data: '', start: end, end, truncated: false };
    if (sinceOffset < this.startOffset) {
      return { data: all.toString('utf8'), start: this.startOffset, end, truncated: true };
    }
    let from = sinceOffset - this.startOffset;
    // 客户端的偏移不会落在字符中间（服务端按整块发），防御性地对齐一下。
    while (from < all.length && (all[from] & 0xc0) === 0x80) from += 1;
    return { data: all.subarray(from).toString('utf8'), start: this.startOffset + from, end, truncated: false };
  }
}
