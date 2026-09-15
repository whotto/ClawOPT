/**
 * 事实来源仲裁的守卫：同一轮次 CLI 输出与本地代理 tee 两路同时到达时，工具卡不重复、文本不拼两遍。
 *
 * 两路描述的是同一次工具调用，但 id 不同（CLI 用 toolu_*，代理用 call_*）——
 * 不仲裁时协调器没有任何办法知道它们是同一个调用，只能各记一张卡。
 * 证明会红：把 `acceptsAdapterEvent` 改成恒返回 true，这里的三条断言都会失败。
 */
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import { defineSourceOfTruth, emptyUsage, type CanonicalEvent } from '../src/runtime/contract';
import { RunCoordinator } from '../src/runtime/coordinator';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

const CLAUDE_LIKE = defineSourceOfTruth({
  text: ['native'],
  tools: 'native',
  terminal: 'native',
  usage: { scoped: 'proxy', global: 'native' },
  control: 'native',
});

describe('事实来源仲裁：同轮双路事件', () => {
  it('scoped 模式下 CLI 与代理同时描述一次工具调用：只记一张工具卡、文本只拼一遍、用量只记代理那一路', async () => {
    const hub = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    hub.listen('arbitration-test', (event) => events.push(event));
    const store = new MemoryRunStore();
    const coordinator = new RunCoordinator({ hub, store, log: () => {} });
    const { adapter, runs } = scriptedAdapter({ id: 'claude-like', sourceOfTruth: CLAUDE_LIKE });
    const projected: CanonicalEvent[] = [];

    const submitted = await coordinator.submit({
      sessionKey: 'room:g1:member:m1',
      surface: 'room',
      topics: ['room:g1'],
      agentId: 'ext:claude-code:eng',
      adapter,
      request: {},
      proxyMode: 'scoped',
      projector: () => ({ onEvent: (event) => projected.push(event), finish: () => ({}) }),
    }, 'reject');
    await flush();
    const run = runs[0];

    // 同一轮：CLI 看到的
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_cli', delta: 'Let me read it.' }, 'native');
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'toolu_1', call_id: 'toolu_1', name: 'Read', arguments: '{"path":"a.ts"}' } }, 'native');
    // 同一轮：代理 tee 看到的（id 不同）
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_proxy', delta: 'Let me read it.' }, 'proxy');
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'Read', arguments: '{"path":"a.ts"}' } }, 'proxy');
    run.emit({ type: 'response.output_item.done', item: { type: 'function_call_output', id: 'o_9', call_id: 'call_9', output: 'file body' } }, 'proxy');
    run.emit({ type: 'usage.reported', usage: { ...emptyUsage('proxy:req_1'), inputTokens: 100 } }, 'proxy');
    run.emit({ type: 'usage.reported', usage: { ...emptyUsage('cli:msg_1'), inputTokens: 100 } }, 'native');
    run.emit({ type: 'response.output_item.done', item: { type: 'function_call_output', id: 'o_1', call_id: 'toolu_1', output: 'file body' } }, 'native');
    run.finish({ kind: 'completed' });
    await (submitted as any).completion;

    const toolStarted = events.filter((e) => e.type === 'tool.started');
    expect(toolStarted.map((e) => (e.payload as any).call_id), '两路各记了一张工具卡').toEqual(['toolu_1']);
    expect(store.toolCallBatches.flat().map((c) => c.callId)).toEqual(['toolu_1']);

    const deltas = events.filter((e) => e.type === 'message.delta').map((e) => (e.payload as any).delta);
    expect(deltas.join(''), '文本被两路拼了两遍').toBe('Let me read it.');

    expect(store.usage.map((u) => u.callId), 'scoped 用量应只信代理').toEqual(['proxy:req_1']);
    expect(projected.filter((e) => e.type === 'response.output_item.added')).toHaveLength(1);
    expect(coordinator.droppedEventCounts().arbitration).toBe(4);
  });
});

/**
 * 两路都收文本（`text: ['proxy', 'native']`，Codex 这类「代理增量求快、CLI 整条消息兜底」）时，
 * 两路描述的是**同一轮、同一段**正文，但 item id 永远不同（代理用 msg_*、CLI 用自己的 item id）。
 * 按 item id 分桶去重对不上：短文本（<16 字符，去重规则一律当真增量）会拼成 `okok`。
 * 协调器必须按「轮次内第几段正文」（工具边界切段）比对两路，而不是按 item id。
 */
describe('事实来源仲裁：两路文本按轮次与段比对，不按 item id', () => {
  const TWO_WAY_TEXT = defineSourceOfTruth({
    text: ['proxy', 'native'],
    tools: 'native',
    terminal: 'native',
    usage: { scoped: 'proxy', global: 'native' },
    control: 'native',
  });

  async function start(sourceOfTruth = TWO_WAY_TEXT) {
    const hub = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    hub.listen('two-way-text', (event) => events.push(event));
    const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), log: () => {} });
    const { adapter, runs } = scriptedAdapter({ id: 'codex-like', sourceOfTruth });
    const projected: CanonicalEvent[] = [];
    const submitted: any = await coordinator.submit({
      sessionKey: 'session:s1', surface: 'chat', topics: ['session:s1'], agentId: 'a', adapter, request: {}, proxyMode: 'scoped',
      projector: () => ({ onEvent: (event) => projected.push(event), finish: () => ({}) }),
    }, 'reject');
    await flush();
    const text = () => events.filter((e) => e.type === 'message.delta').map((e) => (e.payload as any).delta).join('');
    const reasoning = () => events.filter((e) => e.type === 'reasoning.delta').map((e) => (e.payload as any).delta).join('');
    const projectedText = () => projected.filter((e) => e.type === 'response.output_text.delta').map((e: any) => e.delta).join('');
    return { run: runs[0], submitted, text, reasoning, projectedText };
  }

  it('短文本两路各报一遍：只出一次（复现 okok）', async () => {
    const { run, submitted, text, projectedText } = await start();
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_proxy', delta: 'ok' }, 'proxy');
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_cli', delta: 'ok' }, 'native');
    run.finish({ kind: 'completed' });
    await submitted.completion;
    expect(text(), '两路短文本按 item id 分桶，拼成了 okok').toBe('ok');
    expect(projectedText()).toBe('ok');
  });

  it('代理增量先到、CLI 整条消息后到；工具边界之后第二段各自对齐，分隔只加一次', async () => {
    const { run, submitted, text } = await start();
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'Let me check ' }, 'proxy');
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'the file first.' }, 'proxy');
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}' } }, 'proxy');
    run.emit({ type: 'response.output_text.delta', item_id: 'item_0', delta: 'Let me check the file first.' }, 'native');
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'item_1', call_id: 'item_1', name: 'Command', arguments: '{}' } }, 'native');
    run.emit({ type: 'response.output_item.done', item: { type: 'function_call_output', id: 'out_item_1', call_id: 'item_1', output: 'A' } }, 'native');
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_p2', delta: 'ok' }, 'proxy');
    run.emit({ type: 'response.output_text.delta', item_id: 'item_2', delta: '\n\nok' }, 'native');
    run.finish({ kind: 'completed' });
    await submitted.completion;
    expect(text()).toBe('Let me check the file first.\n\nok');
  });

  it('CLI 先到、代理后到（顺序反过来）；某一路跑在前面时另一路只补尾', async () => {
    const { run, submitted, text } = await start();
    run.emit({ type: 'response.output_text.delta', item_id: 'item_0', delta: 'Hello' }, 'native');
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'Hello, wor' }, 'proxy');
    run.emit({ type: 'response.output_text.delta', item_id: 'item_0', delta: ', world' }, 'native');
    run.emit({ type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'ld' }, 'proxy');
    run.finish({ kind: 'completed' });
    await submitted.completion;
    expect(text()).toBe('Hello, world');
  });

  it('推理增量同样按段比对两路', async () => {
    const { run, submitted, reasoning } = await start();
    run.emit({ type: 'response.reasoning.delta', item_id: 'rs_proxy', delta: 'think' }, 'proxy');
    run.emit({ type: 'response.reasoning.delta', item_id: 'rs_cli', delta: 'think' }, 'native');
    run.finish({ kind: 'completed' });
    await submitted.completion;
    expect(reasoning()).toBe('think');
  });

  it('只收一路文本的表不受影响：同一路的重复短增量照样是真增量', async () => {
    const { run, submitted, text } = await start(CLAUDE_LIKE);
    run.emit({ type: 'response.output_text.delta', item_id: 'm', delta: 'ha' }, 'native');
    run.emit({ type: 'response.output_text.delta', item_id: 'm', delta: 'ha' }, 'native');
    run.finish({ kind: 'completed' });
    await submitted.completion;
    expect(text()).toBe('haha');
  });
});
