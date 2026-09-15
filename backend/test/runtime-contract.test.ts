/**
 * 运行时契约的辅助函数：能力声明、事件维度、仲裁表、文本去重、能力与钩子一致性。
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  NATIVE_ONLY_SOURCE_OF_TRUTH,
  acceptsAdapterEvent,
  assertHandleMatchesCapabilities,
  dedupeAppendedText,
  defineCapabilities,
  defineSourceOfTruth,
  emptyUsage,
  facetOf,
  supportsProxyMode,
  type CanonicalEvent,
} from '../src/runtime/contract';
import { PLAIN_CAPABILITIES, scriptedAdapter } from './helpers/scripted-adapter';

describe('能力声明', () => {
  it('声明被冻结，且覆盖契约列出的全部能力', () => {
    const caps = defineCapabilities({ ...PLAIN_CAPABILITIES, proxyMode: ['scoped', 'global'] });
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.proxyMode)).toBe(true);
    expect(Object.keys(caps).sort()).toEqual([...CAPABILITY_KEYS].sort());
  });

  it('代理模式按声明判定；不走代理的运行时拒绝 scoped', () => {
    expect(supportsProxyMode(PLAIN_CAPABILITIES, undefined)).toBe(true);
    expect(supportsProxyMode(PLAIN_CAPABILITIES, 'scoped')).toBe(false);
    expect(supportsProxyMode(defineCapabilities({ ...PLAIN_CAPABILITIES, proxyMode: ['global'] }), 'global')).toBe(true);
  });

  it('声明了能力却不给钩子，第一次启动就报出来', () => {
    const { adapter } = scriptedAdapter({ capabilities: defineCapabilities({ ...PLAIN_CAPABILITIES, boundaryInterrupt: true }) });
    const handle = adapter.start({
      runId: 'r', runMarker: 'm', sessionKey: 's', agentId: 'a', request: {}, signal: new AbortController().signal, emit: () => {},
    });
    expect(() => assertHandleMatchesCapabilities(adapter, handle)).toThrow(/requestBoundaryInterrupt/);
  });
});

describe('事件维度与仲裁表', () => {
  const call: CanonicalEvent = { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'Read', arguments: '{}' } };
  const text: CanonicalEvent = { type: 'response.output_text.delta', item_id: 'm1', delta: 'hi' };
  const usage: CanonicalEvent = { type: 'usage.reported', usage: emptyUsage('u1') };
  const done: CanonicalEvent = { type: 'response.completed', response_id: 'r1' };
  const native = (event: CanonicalEvent) => ({ channel: 'native' as const, event });
  const proxy = (event: CanonicalEvent) => ({ channel: 'proxy' as const, event });

  it('按事件类型归到文本 / 工具 / 终态 / 用量 / 控制', () => {
    expect(facetOf(text)).toBe('text');
    expect(facetOf(call)).toBe('tools');
    expect(facetOf({ type: 'response.output_item.added', item: { type: 'message', id: 'm', role: 'assistant' } })).toBe('text');
    expect(facetOf(done)).toBe('terminal');
    expect(facetOf(usage)).toBe('usage');
    expect(facetOf({ type: 'runtime.native_session', nativeSessionId: 'x' })).toBe('control');
  });

  it('Claude Code 形状：工具与终态只信 CLI，scoped 用量只信代理', () => {
    const table = defineSourceOfTruth({
      text: ['native'], tools: 'native', terminal: 'native', usage: { scoped: 'proxy', global: 'native' }, control: 'native',
    });
    expect(acceptsAdapterEvent(table, 'scoped', native(call))).toBe(true);
    expect(acceptsAdapterEvent(table, 'scoped', proxy(call))).toBe(false);
    expect(acceptsAdapterEvent(table, 'scoped', proxy(text))).toBe(false);
    expect(acceptsAdapterEvent(table, 'scoped', proxy(usage))).toBe(true);
    expect(acceptsAdapterEvent(table, 'scoped', native(usage))).toBe(false);
    expect(acceptsAdapterEvent(table, 'global', native(usage))).toBe(true);
    expect(acceptsAdapterEvent(table, undefined, proxy(done))).toBe(false);
  });

  it('Codex 形状：文本两路都收（后面去重），工具只信 CLI', () => {
    const table = defineSourceOfTruth({
      text: ['proxy', 'native'], tools: 'native', terminal: 'native', usage: { scoped: 'proxy', global: 'native' }, control: 'native',
    });
    expect(acceptsAdapterEvent(table, 'scoped', proxy(text))).toBe(true);
    expect(acceptsAdapterEvent(table, 'scoped', native(text))).toBe(true);
    expect(acceptsAdapterEvent(table, 'scoped', proxy(call))).toBe(false);
  });

  it('只有一路的表不收代理事件；空文本来源的表定义时就拒绝', () => {
    expect(acceptsAdapterEvent(NATIVE_ONLY_SOURCE_OF_TRUTH, undefined, proxy(text))).toBe(false);
    expect(() => defineSourceOfTruth({ ...NATIVE_ONLY_SOURCE_OF_TRUTH, text: [] })).toThrow();
  });
});

describe('文本去重拼接', () => {
  it('累计快照只取新增后缀', () => {
    expect(dedupeAppendedText('The quick brown fox ', 'The quick brown fox jumps over')).toBe('jumps over');
  });

  it('尾部与头部重叠至少 16 字符时去掉重叠', () => {
    const accumulated = 'intro text, then the overlapping part';
    expect(dedupeAppendedText(accumulated, 'the overlapping part and more')).toBe(' and more');
  });

  it('短块一律当真增量（不吃「的」「。」这类偶然重叠）', () => {
    expect(dedupeAppendedText('这是答案的', '的。')).toBe('的。');
  });

  it('没有重叠时原样拼接', () => {
    expect(dedupeAppendedText('first sentence here.', ' A totally different second chunk')).toBe(' A totally different second chunk');
  });
});
