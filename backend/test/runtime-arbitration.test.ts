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
