/**
 * Pi 适配器：RPC、真审批与澄清。
 *
 * fixtures/real-*.rpc.jsonl 是本机 `pi` 0.85.1 `--mode rpc` 的真实往返（2026-09-15，global 模式，gemini；
 * 第二轮用同一个 --session-id 在新进程里续上并调了一次 bash）。行首 `>>` 是写给 Pi 的，`<<` 是 Pi 输出的。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createPiAdapter } from '../../../../src/runtime/adapters/pi';
import { deltaText, submitThroughCoordinator, toolStartedIds } from '../_helpers/coordinator';
import {
  DATA_DIR,
  homeFor,
  SCOPED_PROVIDER,
  USER_HOME,
  baseRequest,
  flushMicrotasks,
  goldenPath,
  harness,
  readFixtureLines,
  renderLaunch,
  startRun,
  writtenFiles,
  type FakeProcess,
} from '../_helpers/harness';

const HOME = homeFor('pi');
const HANDLE = '11111111-1111-4111-8111-111111111111';

async function launched(h = harness(), request = baseRequest(), proxyMode?: 'global' | 'scoped') {
  const adapter = createPiAdapter(h.deps);
  const run = startRun(adapter, request, { proxyMode });
  const proc = await h.exec.next();
  return { h, adapter, run, proc };
}

/** 回放录制里 Pi 输出的那些行（`<<`）。 */
function replayPi(proc: FakeProcess, fixture: string, stopAt?: (event: any) => boolean) {
  for (const raw of readFixtureLines('pi', fixture)) {
    if (!raw.startsWith('<< ')) continue;
    const event = JSON.parse(raw.slice(3));
    if (stopAt?.(event)) break;
    proc.line(event);
  }
}

function writes(proc: FakeProcess): any[] {
  return proc.stdin.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('Pi：命令构造', () => {
  it('global：--mode rpc + 预生成 --session-id + 会话目录在运行时 home；stdin 留给 RPC', async () => {
    const { proc } = await launched();
    expect(proc.spec.args).toEqual(['--mode', 'rpc', '--session-id', HANDLE, '--session-dir', path.join(HOME, 'sessions'), '--no-approve', '--offline']);
    expect(proc.spec.stdin).toBe('pipe');
    expect(proc.stdinEnded).toBe(false);
    expect(writes(proc)).toEqual([{ id: 'clawopt_prompt_run_1', type: 'prompt', message: 'reply with ok' }]);
  });

  it('指令写进 APPEND_SYSTEM.md，经 --append-system-prompt 传文件路径（不进 argv 正文）', async () => {
    const { proc, h } = await launched(harness(), baseRequest({ groupSystemPrompt: '群设定', instructions: '追加' }));
    const file = proc.spec.args[proc.spec.args.indexOf('--append-system-prompt') + 1];
    expect(file).toBe(path.join(HOME, 'APPEND_SYSTEM.md'));
    expect(h.fs.readText(file)).toBe('群设定\n\n追加\n');
  });

  it('金样：global', async () => {
    const h = harness();
    const { proc } = await launched(h, baseRequest({ model: 'google/gemini-3.1-pro-preview', instructions: '用中文' }));
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('pi', 'global-launch.txt'));
  });

  it('金样：scoped（models.json 的 apiKey 用环境变量插值；用户设置去掉 packages / extensions；共享目录软链）', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.pi/agent/settings.json`, JSON.stringify({ theme: 'light', packages: ['npm:pi-mcp-adapter'], extensions: ['./ext.ts'] }));
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, apiMode: 'responses', reasoningEffort: 'high' } }), 'scoped');
    const links = [...h.fs.links.entries()].map(([link, target]) => `${link} -> ${target}`).join('\n');
    await expect(`${renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })}\nsymlinks:\n${links}\n`).toMatchFileSnapshot(goldenPath('pi', 'scoped-launch.txt'));
  });

  it('**scoped：上游 key 与代理令牌都不进文件**', async () => {
    const h = harness();
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const files = [...h.fs.files.values()].map((f) => f.content).join('\n');
    expect(files).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(files).not.toContain('clawopt_proxy_token');
    expect(files).toContain('"apiKey": "$CLAWOPT_PI_API_KEY"');
    expect(proc.spec.env.CLAWOPT_PI_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');
  });

  it('global 放行服务商凭据变量（*_API_KEY），别的挡住', async () => {
    const { proc } = await launched(harness({ processEnv: { PATH: '/bin', GEMINI_API_KEY: 'g', SECRET_TOKEN: 's' } }));
    expect(proc.spec.env.GEMINI_API_KEY).toBe('g');
    expect(proc.spec.env.SECRET_TOKEN).toBeUndefined();
  });

  it('推理强度：先 set_thinking_level 再 prompt；none→off，default 不发', async () => {
    const high = await launched(harness(), baseRequest({ reasoningEffort: 'none' }));
    expect(writes(high.proc).map((w) => w.type)).toEqual(['set_thinking_level', 'prompt']);
    expect(writes(high.proc)[0].level).toBe('off');
    const dflt = await launched(harness(), baseRequest({ reasoningEffort: 'default' }));
    expect(writes(dflt.proc).map((w) => w.type)).toEqual(['prompt']);
  });

  it('图片进 prompt 的 images', async () => {
    const { proc } = await launched(harness(), baseRequest({ images: [{ path: '/a.png', mimeType: 'image/png', data: 'AAAA' }] }));
    expect(writes(proc)[0].images).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  });
});

describe('Pi：解析真实 RPC', () => {
  it('首轮：prompt 应答确认原生会话；agent_settled 之后停进程；close 之后才 completed', async () => {
    const { run, proc, h } = await launched();
    replayPi(proc, 'real-global-turn1.rpc.jsonl', (e) => e.type === 'response' && e.command !== 'prompt');
    await flushMicrotasks();
    expect(proc.terminateCalls, 'agent_settled 之后没停进程').toBe(1);
    expect(proc.stdinEnded).toBe(true);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    const events = run.canonical() as any[];
    expect(events.find((e) => e.type === 'runtime.native_session').nativeSessionId).toBe(HANDLE);
    const usage = events.filter((e) => e.type === 'usage.reported').map((e) => e.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'gemini-3.1-pro-preview', provider: 'google', inputTokens: 4480, outputTokens: 65, reasoningTokens: 64 });
    expect(usage[0].costUsd).toBeCloseTo(0.00974, 5);
    expect(JSON.parse(h.fs.readText(path.join(HOME, '.clawopt-session.json'))!)).toMatchObject({ nativeSessionId: HANDLE, confirmed: true });
  });

  it('工具轮：bash 一张卡、输出进 function_call_output；两次模型调用两行用量（turn_end 里重复的消息不再记）', async () => {
    const { run, proc } = await launched();
    replayPi(proc, 'real-global-resume-tool-turn2.rpc.jsonl', (e) => e.type === 'response' && e.command !== 'prompt');
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    const events = run.canonical() as any[];
    const calls = events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    expect(calls.map((e) => [e.item.call_id, e.item.name])).toEqual([['call_9525215', 'bash']]);
    expect(events.find((e) => e.item?.type === 'function_call_output').item).toMatchObject({ output: 'hi\n', status: 'completed' });
    // 两次模型调用（工具调用那一次与最终回答）各记一行；turn_end / agent_end 里重复的消息不再记。
    expect(events.filter((e) => e.type === 'usage.reported')).toHaveLength(2);
  });

  it('自动重试挂着时 agent_settled 不算结束', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'agent_end', willRetry: true });
    proc.line({ type: 'agent_settled' });
    await flushMicrotasks();
    expect(proc.terminateCalls).toBe(0);
    proc.line({ type: 'auto_retry_end', success: true });
    proc.line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
    proc.line({ type: 'agent_settled' });
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
  });

  it('message_end stopReason error：runtime.apiError，带上 errorMessage', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 quota exceeded' } });
    proc.line({ type: 'agent_settled' });
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.apiError', error: '429 quota exceeded' });
  });

  it('prompt 被拒（没有可用的模型凭据）：runtime.notLoggedIn，立刻停进程', async () => {
    const { run, proc } = await launched();
    proc.line({ id: 'clawopt_prompt_run_1', type: 'response', command: 'prompt', success: false, error: 'No API key found for google' });
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn' });
  });

  it('没等到 agent_settled 进程就关了：runtime.sessionClosed', async () => {
    const { run, proc } = await launched(harness({ executorOptions: { closeOnTerminate: false } }));
    proc.line({ type: 'agent_start' });
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.sessionClosed' });
  });
});

describe('Pi：审批与澄清（真映射）', () => {
  it('confirm → 审批（once / deny），once 回 confirmed: true', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run rm -rf?', message: 'dangerous', timeout: 30000 });
    const request = (run.canonical().find((e) => e.type === 'approval.requested') as any).request;
    expect(request).toMatchObject({ approvalId: 'pi:run_1:ui-1', agentId: 'agent-1', title: 'Run rm -rf?', description: 'dangerous', choices: ['once', 'deny'], timeoutMs: 30000 });
    expect(run.handle.resolveApproval!('pi:run_1:ui-1', 'once')).toBe(true);
    expect(writes(proc).at(-1)).toEqual({ type: 'extension_ui_response', id: 'ui-1', confirmed: true });
    expect(run.handle.resolveApproval!('pi:run_1:ui-1', 'once'), '同一个请求不能答两次').toBe(false);
  });

  it('deny 回 confirmed: false；没提供的选项（session / always）不答', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: 'x' });
    expect(run.handle.resolveApproval!('pi:run_1:ui-2', 'session')).toBe(false);
    expect(run.handle.resolveApproval!('pi:run_1:ui-2', 'deny')).toBe(true);
    expect(writes(proc).at(-1)).toEqual({ type: 'extension_ui_response', id: 'ui-2', confirmed: false });
  });

  it('select → 带选项的澄清；回答必须是选项之一，否则回 cancelled', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'extension_ui_request', id: 'ui-3', method: 'select', title: 'Pick', options: ['Allow', 'Block'] });
    proc.line({ type: 'extension_ui_request', id: 'ui-4', method: 'select', title: 'Pick again', options: ['A'] });
    const requests = run.canonical().filter((e) => e.type === 'clarify.requested').map((e: any) => e.request);
    expect(requests[0]).toMatchObject({ clarifyId: 'pi:run_1:ui-3', question: 'Pick', choices: ['Allow', 'Block'] });
    expect(run.handle.resolveClarify!('pi:run_1:ui-3', 'Block')).toBe(true);
    expect(run.handle.resolveClarify!('pi:run_1:ui-4', 'Nope')).toBe(true);
    expect(writes(proc).slice(-2)).toEqual([
      { type: 'extension_ui_response', id: 'ui-3', value: 'Block' },
      { type: 'extension_ui_response', id: 'ui-4', cancelled: true },
    ]);
  });

  it('input / editor → 自由文本澄清；editor 的预填进问题；回答截到 20000 字符', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'extension_ui_request', id: 'ui-5', method: 'editor', title: 'Edit', prefill: 'line1' });
    const request = (run.canonical().find((e) => e.type === 'clarify.requested') as any).request;
    expect(request).toMatchObject({ question: 'Edit\n\nline1', choices: null });
    run.handle.resolveClarify!('pi:run_1:ui-5', 'x'.repeat(25_000));
    expect(writes(proc).at(-1).value).toHaveLength(20_000);
  });

  it('认不出的对话方法立刻 cancelled；notify / setStatus 忽略', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'extension_ui_request', id: 'ui-6', method: 'custom_picker', title: 'x' });
    proc.line({ type: 'extension_ui_request', id: 'ui-7', method: 'notify', message: 'hi' });
    expect(writes(proc).slice(1)).toEqual([{ type: 'extension_ui_response', id: 'ui-6', cancelled: true }]);
    expect(run.canonical().some((e) => e.type === 'approval.requested' || e.type === 'clarify.requested')).toBe(false);
  });

  it('经协调器：审批注册表把用户的选择交回 Pi', async () => {
    const h = harness();
    const { coordinator, submitted, realtime } = await submitThroughCoordinator(createPiAdapter(h.deps), baseRequest(), 'global');
    const proc = await h.exec.next();
    proc.line({ type: 'extension_ui_request', id: 'ui-8', method: 'confirm', title: 'Deploy?' });
    await flushMicrotasks();
    expect(realtime.some((e) => e.type === 'approval.requested')).toBe(true);
    expect(coordinator.respondInteraction('session:s1', 'pi:' + submitted.run.runId + ':ui-8', { choice: 'once' })).toMatchObject({ resolved: true });
    await flushMicrotasks();
    expect(writes(proc).at(-1)).toEqual({ type: 'extension_ui_response', id: 'ui-8', confirmed: true });
    proc.line({ type: 'agent_settled' });
    await submitted.completion;
  });
});

describe('Pi：会话命令、中止、续话、错误', () => {
  it('status → get_state，结果原样放进 outputText', async () => {
    const { run, proc } = await launched(harness(), baseRequest({ command: { kind: 'status' } }));
    expect(writes(proc)).toEqual([{ id: 'clawopt_cmd_0', type: 'get_state' }]);
    proc.line({ id: 'clawopt_cmd_0', type: 'response', command: 'get_state', success: true, data: { thinkingLevel: 'high', messageCount: 2 } });
    const outcome = await run.done as any;
    expect(outcome).toMatchObject({ kind: 'completed', stopReason: 'session_command:status' });
    expect(JSON.parse(outcome.outputText)).toEqual({ thinkingLevel: 'high', messageCount: 2 });
  });

  it('compact → RPC compact（带自定义指令），回压缩前后 token 与摘要', async () => {
    const { run, proc } = await launched(harness(), baseRequest({ command: { kind: 'compact', instructions: '保留结论' } }));
    expect(writes(proc)).toEqual([{ id: 'clawopt_cmd_0', type: 'compact', customInstructions: '保留结论' }]);
    proc.line({ id: 'clawopt_cmd_0', type: 'response', command: 'compact', success: true, data: { summary: '摘要', tokensBefore: 150000, estimatedTokensAfter: 32000 } });
    expect(await run.done).toMatchObject({ kind: 'completed', stopReason: 'compacted', outputText: '摘要' });
    expect(run.canonical().find((e) => e.type === 'plan.updated')).toMatchObject({ plan: { preTokens: 150000, postTokens: 32000 } });
  });

  it('中止：先发 RPC abort、挂着的对话回 cancelled，再停进程组', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'extension_ui_request', id: 'ui-9', method: 'confirm', title: 'x' });
    run.abort.abort();
    await flushMicrotasks();
    expect(writes(proc).slice(-2)).toEqual([{ type: 'abort' }, { type: 'extension_ui_response', id: 'ui-9', cancelled: true }]);
    expect(proc.terminateCalls).toBe(1);
    expect(await run.done).toMatchObject({ kind: 'aborted', synced: true });
  });

  it('续话：下一轮新进程用同一个 --session-id（Pi 的「有就用、没有就建」）', async () => {
    const h = harness();
    const first = await launched(h);
    replayPi(first.proc, 'real-global-turn1.rpc.jsonl', (e) => e.type === 'response' && e.command !== 'prompt');
    await first.run.done;
    const second = await launched(h, baseRequest({ resume: true }));
    expect(second.proc.spec.args[second.proc.spec.args.indexOf('--session-id') + 1]).toBe(HANDLE);
  });

  it('scoped 下换了模型：换一个新的原生会话 id', async () => {
    const h = harness();
    const first = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    first.proc.line({ id: 'clawopt_prompt_run_1', type: 'response', command: 'prompt', success: true });
    first.proc.line({ type: 'agent_settled' });
    await first.run.done;
    const second = await launched(h, baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, model: 'other' } }), 'scoped');
    expect(second.proc.spec.args[second.proc.spec.args.indexOf('--session-id') + 1]).not.toBe(HANDLE);
  });

  it('没安装：runtime.notInstalled', async () => {
    const h = harness();
    h.manager.missing = true;
    expect(await startRun(createPiAdapter(h.deps), baseRequest()).done).toMatchObject({ code: 'runtime.notInstalled' });
  });
});

describe('Pi：同轮双路事件仲裁', () => {
  it('scoped：代理 tee 与 RPC 都报了工具调用 → 一张卡；文本只信 RPC；用量只信代理', async () => {
    const h = harness();
    const { store, realtime, submitted, runId } = await submitThroughCoordinator(createPiAdapter(h.deps), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await h.exec.next();
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'msg_p', delta: 'ok' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call_p', name: 'bash', arguments: '{}' } });
    h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:1', scope: 'model_call', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    proc.line({ type: 'tool_execution_start', toolCallId: 'call_native', toolName: 'bash', args: { command: 'ls' } });
    proc.line({ type: 'tool_execution_end', toolCallId: 'call_native', result: { content: [{ type: 'text', text: 'a' }] }, isError: false });
    proc.line({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } });
    proc.line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: { input: 5, output: 1 }, timestamp: 1, model: 'm' } });
    proc.line({ type: 'agent_settled' });
    await submitted.completion;
    expect(toolStartedIds(realtime)).toEqual(['call_native']);
    expect(deltaText(realtime)).toBe('ok');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:1']);
  });
});
