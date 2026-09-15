/**
 * 两路文本仲裁：适配器的事实来源表声明 `text: ['proxy', 'native']` 时（Codex 这类「代理增量求快、CLI 整条消息兜底」），
 * 同一轮正文会从两路各来一遍，而且 **item id 永远对不上**（代理 `msg_*`，CLI 用自己的 item id）。
 *
 * 按 item id 分桶去重的后果是具体的：两路各报一次 `ok`，短于 16 字符的块一律当真增量，拼出 `okok`。
 * 这里按「这一轮里第几段正文」比对：
 *
 * - **段**：一路在出过正文之后遇到工具调用 / 工具结果，就进入下一段；两路各自数自己的段（代理的工具事件在工具维度上
 *   会被仲裁丢掉，但仍然算这一路的段边界）。连续多个工具只算一次边界，所以两路对并行调用的计数方式不同也对得上；
 * - **同一段内**：每一路累计自己说过的文本 C，与这一段已经发出的文本 P 比：C 是 P 的前缀 → 另一路已经说过，丢；
 *   P 是 C 的前缀 → 只发多出来的尾巴；分叉 → 这一段先开口的那一路（主路）照发，另一路丢；
 * - **段首分隔**：各路段首的换行不参与比对（CLI 自己会在工具之后加空行，代理不加），段与段之间的空行由这里统一加一次。
 *
 * 只收一路文本的表不走这里（同一路重复的短增量本来就是真增量）。
 */
import type { RuntimeChannel } from '../contract';

interface Segment {
  published: string;
  primary: RuntimeChannel | null;
  said: Record<RuntimeChannel, string>;
}

export class TurnTextArbiter {
  private readonly segments: Segment[] = [];
  private readonly index: Record<RuntimeChannel, number> = { native: 0, proxy: 0 };
  private readonly spoke: Record<RuntimeChannel, boolean> = { native: false, proxy: false };
  private total = '';

  private segment(position: number): Segment {
    while (this.segments.length <= position) {
      this.segments.push({ published: '', primary: null, said: { native: '', proxy: '' } });
    }
    return this.segments[position];
  }

  /** 这一路遇到了工具边界（调用开始 / 结束 / 结果）。 */
  boundary(channel: RuntimeChannel): void {
    if (!this.spoke[channel]) return;
    this.index[channel] += 1;
    this.spoke[channel] = false;
  }

  /** 这一路来了一块文本；返回应当发出去的部分（空串 = 丢弃）。 */
  accept(channel: RuntimeChannel, delta: string): string {
    if (!delta) return '';
    const segment = this.segment(this.index[channel]);
    this.spoke[channel] = true;
    segment.said[channel] += delta;
    const said = segment.said[channel].replace(/^\n+/, '');
    if (!said) return '';

    const published = segment.published;
    let addition: string;
    if (published.startsWith(said)) {
      return '';
    } else if (said.startsWith(published)) {
      addition = said.slice(published.length);
    } else if (segment.primary === channel) {
      addition = delta;
    } else {
      return '';
    }
    if (!addition) return '';

    let separator = '';
    if (!published) {
      segment.primary = channel;
      if (this.total) separator = this.total.endsWith('\n\n') ? '' : this.total.endsWith('\n') ? '\n' : '\n\n';
    }
    segment.published += addition;
    this.total += separator + addition;
    return separator + addition;
  }
}
