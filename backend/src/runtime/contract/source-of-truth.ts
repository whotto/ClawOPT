/**
 * 事实来源仲裁表：同一轮次两路事件同时到达时，每个维度只信一路。
 *
 * 不仲裁的后果是具体的：Claude Code 走本地代理时，CLI 的 stream-json 与代理 tee
 * 各自描述同一次工具调用，id 不同——前端就会出现两张一样的工具卡，文本也会拼两遍。
 *
 * 表写成**数据**而不是散在各适配器的 if 里：新运行时接进来只需要填表，
 * 协调器按表过滤；守卫用例把「两路同时到达不重复」钉住（test/runtime-arbitration.test.ts）。
 */
import type { ProxyMode } from './capabilities';
import { facetOf, type AdapterEvent, type RuntimeChannel } from './events';

export interface SourceOfTruthTable {
  /** 文本与推理增量信哪几路。多于一路时协调器用去重拼接（text-dedupe.ts），例如 Codex 收代理增量求快、CLI 终文去重。 */
  readonly text: readonly RuntimeChannel[];
  /** 工具调用的生命周期只信一路。 */
  readonly tools: RuntimeChannel;
  /** 轮次终态信哪一路。另一路的终态只当作信息（例如只拿走用量）。 */
  readonly terminal: RuntimeChannel;
  /** 用量：scoped 模式下代理看得到真实计费；global 模式只能信运行时自己报的。 */
  readonly usage: { readonly scoped: RuntimeChannel; readonly global: RuntimeChannel };
  /** 审批、澄清、计划、原生会话 id 等控制事件。 */
  readonly control: RuntimeChannel;
}

export function defineSourceOfTruth(table: SourceOfTruthTable): Readonly<SourceOfTruthTable> {
  if (table.text.length === 0) throw new Error('source-of-truth table must accept text from at least one channel');
  return Object.freeze({ ...table, text: Object.freeze([...table.text]), usage: Object.freeze({ ...table.usage }) });
}

/**
 * 这一路的这个事件该不该收。
 *
 * `proxyMode` 缺省按 global 处理：没走代理时代理那一路本来就不该有事件，
 * 真出现了就是串线，按 global 表会被丢掉。
 */
export function acceptsAdapterEvent(
  table: SourceOfTruthTable,
  proxyMode: ProxyMode | undefined,
  adapterEvent: AdapterEvent,
): boolean {
  const { channel, event } = adapterEvent;
  switch (facetOf(event)) {
    case 'text':
      return table.text.includes(channel);
    case 'tools':
      return table.tools === channel;
    case 'terminal':
      return table.terminal === channel;
    case 'usage':
      return table.usage[proxyMode ?? 'global'] === channel;
    case 'control':
      return table.control === channel;
  }
}

/** 只有一路（运行时自己的输出）的表：OpenClaw 网关、不走代理的 CLI。 */
export const NATIVE_ONLY_SOURCE_OF_TRUTH = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'native', global: 'native' },
  control: 'native',
});

