/**
 * P1b 工具轨迹：线上截断（JSON 按结构、diff 不按 1000 截、纯文本前缀）、存储上限（头尾保留）、参数预览、
 * 按运行分组的摘要接口与完整内容接口（只查本会话）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundToolOutputForStorage, looksLikeUnifiedDiff, previewToolArguments, STORAGE_MAX_BYTES, truncateForWire } from '../src/runtime/contract';
import { startAppHarness, type AppHarness } from './helpers/app-harness';
import { RealtimeHub } from '../src/core/realtime';
import { RunCoordinator } from '../src/runtime/coordinator';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

describe('工具输出上限', () => {
  it('线上：JSON 按结构截并标出省略；小 JSON 原样美化；diff 不按 1000 截；纯文本截前缀并带原长', () => {
    const big = JSON.stringify({ items: Array.from({ length: 80 }, (_, i) => ({ id: i, note: 'x'.repeat(300) })) });
    const wire = truncateForWire(big);
    expect(wire).toMatchObject({ truncated: true, originalLength: big.length, format: 'json' });
    expect(wire.text.length).toBeLessThanOrEqual(1002);
    expect(truncateForWire('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', truncated: false, originalLength: 7, format: 'json' });
    const diff = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-${'o'.repeat(2000)}\n+${'n'.repeat(2000)}\n`;
    expect(looksLikeUnifiedDiff(diff)).toBe(true);
    expect(truncateForWire(diff)).toMatchObject({ truncated: false, format: 'diff' });
    expect(truncateForWire('y'.repeat(1500))).toMatchObject({ truncated: true, originalLength: 1500, format: 'text' });
  });

  it('存储：超过 256 KB 保留头尾与说明，未超过原样', () => {
    expect(boundToolOutputForStorage('small')).toBe('small');
    expect(boundToolOutputForStorage(null)).toBeNull();
    const huge = `HEAD${'a'.repeat(STORAGE_MAX_BYTES * 2)}TAIL`;
    const stored = boundToolOutputForStorage(huge)!;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThan(STORAGE_MAX_BYTES + 200);
    expect(stored.startsWith('HEAD')).toBe(true);
    expect(stored.endsWith('TAIL')).toBe(true);
    expect(stored).toContain('truncated for storage');
  });

  it('参数预览：取命令 / 路径 / 查询等第一个有意义的字段，折叠空白，≤160', () => {
    expect(previewToolArguments(JSON.stringify({ command: 'ls   -la\n/tmp' }))).toBe('ls -la /tmp');
    expect(previewToolArguments(JSON.stringify({ file_path: '/a/b.ts', content: 'zzz' }))).toBe('/a/b.ts');
    expect(previewToolArguments(JSON.stringify({ command: ['git', 'status'] }))).toBe('git status');
    expect(previewToolArguments(JSON.stringify({ query: 'q'.repeat(300) }))).toHaveLength(160);
    expect(previewToolArguments('not json')).toBe('not json');
  });
});

describe('协调器落库时施加存储上限', () => {
  it('超大工具结果落进 run_tool_calls 前被截成头尾', async () => {
    const store = new MemoryRunStore();
    const coordinator = new RunCoordinator({ hub: new RealtimeHub(), store, log: () => {} });
    const scripted = scriptedAdapter();
    await coordinator.submit({ sessionKey: 's', surface: 'chat', topics: ['session:s'], agentId: 'a', adapter: scripted.adapter, request: {}, projector: () => ({ onEvent: () => {}, finish: () => ({}) }) }, 'queue');
    await flush();
    const run = scripted.runs[0];
    run.emit({ type: 'response.output_item.added', item: { type: 'function_call', id: 'i', call_id: 'c', name: 'Bash', arguments: '{}' } });
    run.emit({ type: 'response.output_item.done', item: { type: 'function_call_output', id: 'o', call_id: 'c', output: 'x'.repeat(STORAGE_MAX_BYTES * 3) } });
    run.finish({ kind: 'completed' });
    await flush();
    const stored = store.toolCallBatches.flat()[0].output!;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThan(STORAGE_MAX_BYTES + 200);
  });
});

describe('工具轨迹接口', () => {
  let h: AppHarness;
  beforeAll(async () => { h = await startAppHarness(); });
  afterAll(async () => { await h.close(); });

  it('按消息所在运行分组；截断在线上；完整内容只能按本会话取；存储上限经协调器落库时施加', async () => {
    h.ctx.sessionManager.createSession({ id: 'tt-1', name: 'T', agentId: 'main' });
    h.ctx.sessionManager.createSession({ id: 'tt-2', name: 'T2', agentId: 'main' });
    const assistant = Number(h.ctx.db.saveMessage({ session_key: 'tt-1', role: 'assistant', content: 'done' }));
    h.ctx.db.setChatMessagesRunMarker([assistant], 'run-tt');
    const longOutput = 'z'.repeat(5000);
    h.ctx.db.persistToolCalls([
      { sessionKey: 'tt-1', runId: 'r', runMarker: 'run-tt', callId: 'c1', name: 'Bash', arguments: JSON.stringify({ command: 'ls' }), output: longOutput, status: 'completed', startedAt: 1000, completedAt: 1250 },
      { sessionKey: 'tt-1', runId: 'r', runMarker: 'run-tt', callId: 'c2', name: 'Read', arguments: JSON.stringify({ file_path: '/x' }), output: 'boom', status: 'failed', startedAt: 1300, completedAt: 1400 },
    ]);
    const traces = await (await fetch(`${h.baseUrl}/api/chat/tt-1/tool-calls?messageIds=${assistant},999`)).json() as any;
    expect(traces.runs).toHaveLength(1);
    const [call1, call2] = traces.runs[0].calls;
    expect(call1).toMatchObject({ name: 'Bash', status: 'completed', durationMs: 250, preview: 'ls', output: { truncated: true, originalLength: 5000 } });
    expect(call2).toMatchObject({ name: 'Read', status: 'failed', preview: '/x' });
    const full = await (await fetch(`${h.baseUrl}/api/chat/tt-1/tool-calls/${call1.id}`)).json() as any;
    expect(full.call.output).toBe(longOutput);
    expect((await fetch(`${h.baseUrl}/api/chat/tt-2/tool-calls/${call1.id}`)).status).toBe(404);
    const otherSession = await (await fetch(`${h.baseUrl}/api/chat/tt-2/tool-calls?messageIds=${assistant}`)).json() as any;
    expect(otherSession.runs).toEqual([]);
  });
});
