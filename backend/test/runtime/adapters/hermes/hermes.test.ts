/**
 * Hermes Agent 适配器（ACP，真审批）。
 *
 * fixtures/real-*-acp.jsonl 是 Hermes Agent 0.21.3（隔离 venv，本地假上游）`hermes acp` 的真实往返：
 * 危险命令的权限请求（拒绝 / 允许）、没配服务商、中止、跨进程 resume（历史先重放）、scoped 基本一轮。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { acpChoicesFor, acpOptionFor } from '../../../../src/runtime/adapters/_shared/acp';
import { createHermesAdapter, hermesTextError } from '../../../../src/runtime/adapters/hermes';
import { runtimeHomeDir } from '../../../../src/runtime/adapters/_shared/runtime-home';
import { loadAcpFixture, recordedBatch, replayAcp, type AcpReplay } from '../_helpers/acp';
import { deltaText, submitThroughCoordinator, toolStartedIds } from '../_helpers/coordinator';
import {
  DATA_DIR,
  SCOPED_PROVIDER,
  WORKSPACE,
  baseRequest,
  flushMicrotasks,
  goldenPath,
  harness,
  renderLaunch,
  startRun,
  writtenFiles,
} from '../_helpers/harness';

const HOME = runtimeHomeDir(DATA_DIR, 'hermes', { kind: 'session', sessionKey: 'session:s1' });
const DENY = loadAcpFixture('hermes', 'real-tool-deny-acp.jsonl');
const DENY_SESSION = '6db5f2d2-8f84-49d1-afdc-5b837df9d5be';
const HERMES_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once' },
  { optionId: 'allow_session', kind: 'allow_always' },
  { optionId: 'allow_always', kind: 'allow_always' },
  { optionId: 'deny', kind: 'reject_once' },
  { optionId: 'deny_always', kind: 'reject_always' },
];

function acpHarness(fixture = DENY, overrides: Parameters<typeof replayAcp>[2] = {}) {
  const replays: AcpReplay[] = [];
  const h = harness({ executorOptions: { onLaunch: (proc) => { replays.push(replayAcp(proc, fixture, overrides)); } } });
  return { h, replays };
}

async function runTurn(options: { fixture?: typeof DENY; overrides?: Parameters<typeof replayAcp>[2]; request?: ReturnType<typeof baseRequest>; mode?: 'global' | 'scoped'; h?: ReturnType<typeof acpHarness> } = {}) {
  const ah = options.h ?? acpHarness(options.fixture, options.overrides);
  const run = startRun(createHermesAdapter(ah.h.deps), options.request ?? baseRequest(), { proxyMode: options.mode });
  const proc = await ah.h.exec.next();
  return { ...ah, run, proc, replay: ah.replays[ah.replays.length - 1] };
}

async function closeWhenStdinEnds(proc: Awaited<ReturnType<typeof runTurn>>['proc']) {
  for (let i = 0; i < 200 && !proc.stdinEnded; i += 1) await flushMicrotasks(1);
  proc.close(0);
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await flushMicrotasks(1);
}

const methods = (replay: AcpReplay) => replay.sent.filter((m) => m.method).map((m) => m.method);

describe('Hermes：命令构造', () => {
  it('global：hermes acp --accept-hooks；stdin 留给 ACP；不设 HERMES_HOME、不写配置', async () => {
    const { proc, h } = await runTurn();
    expect(proc.spec.args).toEqual(['acp', '--accept-hooks']);
    expect(proc.spec.stdin).toBe('pipe');
    expect(proc.spec.env.HERMES_HOME).toBeUndefined();
    expect(writtenFiles(h.fs, HOME)).toEqual([]);
  });

  it('金样：scoped（config.yaml 只有 ${VAR} 引用、anthropic_messages 走代理的 Anthropic 路由）', async () => {
    const { proc, h } = await runTurn({ request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec })).toMatchFileSnapshot(goldenPath('hermes', 'scoped-launch.txt'));
  });

  it('**scoped：上游 key 与代理令牌都不进文件**，只在进程环境里', async () => {
    const { proc, h } = await runTurn({ request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    const config = h.fs.readText(path.join(HOME, 'hermes-home', 'config.yaml'))!;
    expect(config).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(config).not.toContain('clawopt_proxy_token');
    expect(config).toContain('api_key: ${CLAWOPT_HERMES_API_KEY}');
    expect(proc.spec.env).toMatchObject({
      HERMES_HOME: path.join(HOME, 'hermes-home'),
      CLAWOPT_HERMES_API_KEY: 'clawopt_proxy_token_abcdefghijkl',
      CLAWOPT_HERMES_BASE_URL: 'http://127.0.0.1:3150/api/claude-code-proxy/route_1',
      CLAWOPT_HERMES_MODEL: 'deepseek-v4',
    });
  });

  it('global 放行 HERMES_* 与服务商凭据；scoped 不继承（否则 Hermes 会自己挑一个 openrouter 去打）', async () => {
    const processEnv = { PATH: '/bin', OPENROUTER_API_KEY: 'or', HERMES_HOME: '/h/.hermes', SECRET_TOKEN: 's' };
    const g = acpHarness();
    g.h.deps.processEnv = processEnv;
    const global = await runTurn({ h: g });
    expect(global.proc.spec.env).toMatchObject({ OPENROUTER_API_KEY: 'or', HERMES_HOME: '/h/.hermes' });
    expect(global.proc.spec.env.SECRET_TOKEN).toBeUndefined();
    const s = acpHarness();
    s.h.deps.processEnv = processEnv;
    const scoped = await runTurn({ h: s, request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    expect(scoped.proc.spec.env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('指令作为 prompt 的第一个文本块；图片作为 image 块（initialize 声明 image=true）', async () => {
    const { run, proc, replay } = await runTurn({
      request: baseRequest({ groupSystemPrompt: '群设定', images: [{ path: '/a.png', mimeType: 'image/png', data: 'AAAA' }] }),
      overrides: { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] },
    });
    await closeWhenStdinEnds(proc);
    await run.done;
    const blocks = replay.sent.find((m) => m.method === 'session/prompt').params.prompt;
    expect(blocks[0].text).toContain('群设定');
    expect(blocks.slice(1)).toEqual([{ type: 'text', text: 'reply with ok' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }]);
  });

  it('/compress 作为一轮输入发出（压缩）', async () => {
    const { run, proc, replay } = await runTurn({
      request: baseRequest({ command: { kind: 'compact', instructions: '保留结论' } }),
      overrides: { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] },
    });
    await closeWhenStdinEnds(proc);
    await run.done;
    expect(replay.sent.find((m) => m.method === 'session/prompt').params.prompt).toEqual([{ type: 'text', text: '/compress 保留结论' }]);
  });
});

describe('Hermes：真审批', () => {
  it('ACP 选项 → ClawOPT 选择：once / session / always / deny 各对一个 optionId', () => {
    expect(acpChoicesFor(HERMES_OPTIONS)).toEqual(['once', 'session', 'always', 'deny']);
    expect(['once', 'session', 'always', 'deny'].map((d) => acpOptionFor(d as any, HERMES_OPTIONS))).toEqual(['allow_once', 'allow_session', 'allow_always', 'deny']);
    // DSH 只有两个选项（id 用连字符）
    expect(acpChoicesFor([{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once', kind: 'reject_once' }])).toEqual(['once', 'deny']);
  });

  it('危险命令（真实录制）：权限请求变成审批，用户拒绝 → 回 optionId deny；工具记为失败', async () => {
    const { run, proc, replay } = await runTurn();
    await waitFor(() => run.canonical().some((e) => e.type === 'approval.requested'));
    const request = (run.canonical().find((e) => e.type === 'approval.requested') as any).request;
    expect(request).toMatchObject({ approvalId: 'acp:run_1:0', agentId: 'agent-1', title: 'recursive delete: rm -rf ./junkdir', command: 'rm -rf ./junkdir', choices: ['once', 'session', 'always', 'deny'] });
    expect(run.handle.resolveApproval!('acp:run_1:0', 'deny')).toBe(true);
    await waitFor(() => replay.answers.length > 0);
    expect(replay.answers[0]).toEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'deny' } } });
    await closeWhenStdinEnds(proc);
    const outcome = await run.done as any;
    expect(outcome.kind).toBe('completed');
    const output = run.canonical().find((e: any) => e.item?.type === 'function_call_output') as any;
    expect(output.item.status).toBe('failed');
    expect(output.item.output).toContain('BLOCKED');
    expect(run.canonical().find((e) => e.type === 'usage.reported')).toMatchObject({ usage: { callId: `hermes:${DENY_SESSION}:run_1`, inputTokens: 222, outputTokens: 44 } });
  });

  it('允许（真实录制）：session 选择回 allow_session；同一个审批不能答两次', async () => {
    const fixture = loadAcpFixture('hermes', 'real-tool-allow-acp.jsonl');
    const { run, proc, replay } = await runTurn({ fixture });
    await waitFor(() => run.canonical().some((e) => e.type === 'approval.requested'));
    expect(run.handle.resolveApproval!('acp:run_1:0', 'session')).toBe(true);
    expect(run.handle.resolveApproval!('acp:run_1:0', 'once')).toBe(false);
    await waitFor(() => replay.answers.length > 0);
    expect(replay.answers[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_session' } });
    await closeWhenStdinEnds(proc);
    await run.done;
  });

  it('经协调器：审批注册表把用户选择交回 Hermes', async () => {
    const ah = acpHarness();
    const { coordinator, submitted, realtime } = await submitThroughCoordinator(createHermesAdapter(ah.h.deps), baseRequest(), 'global');
    const proc = await ah.h.exec.next();
    await waitFor(() => realtime.some((e) => e.type === 'approval.requested'));
    expect(coordinator.respondInteraction('session:s1', `acp:${submitted.run.runId}:0`, { choice: 'always' })).toMatchObject({ resolved: true });
    await waitFor(() => ah.replays[0].answers.length > 0);
    expect(ah.replays[0].answers[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    await closeWhenStdinEnds(proc);
    await submitted.completion;
  });

  it('中止时挂着的权限请求回 cancelled，并发 session/cancel', async () => {
    // 只回放到权限请求为止（录制里后面紧跟着 prompt 的应答，本轮会直接结束）。
    const upToPermission = recordedBatch(DENY, 'session/prompt').filter((m) => m.method === 'session/update' || m.method === 'session/request_permission').slice(0, 5);
    const { run, replay } = await runTurn({ overrides: { 'session/prompt': () => upToPermission } });
    await waitFor(() => run.canonical().some((e) => e.type === 'approval.requested'));
    run.abort.abort();
    await waitFor(() => replay.answers.length > 0);
    expect(replay.answers[0].result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(replay.sent.map((m) => m.method ?? `answer:${m.id}`)).toContain('session/cancel');
    expect(await run.done).toMatchObject({ kind: 'aborted' });
  });
});

describe('Hermes：ACP 往返与错误', () => {
  it('没配服务商（真实录制）：session/new 回 -32603 → runtime.notLoggedIn，详情取 data.details', async () => {
    const fixture = loadAcpFixture('hermes', 'real-no-provider-acp.jsonl');
    const { run, proc } = await runTurn({ fixture });
    await closeWhenStdinEnds(proc);
    const outcome = await run.done as any;
    expect(outcome).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn' });
    expect(outcome.error).toContain('No LLM provider configured');
  });

  it('上游错误被当成正文吐出来（stopReason 仍是 end_turn）：按错误判', async () => {
    expect(hermesTextError('HTTP 401: Missing Authentication header')).toEqual({ code: 'runtime.notLoggedIn', detail: 'HTTP 401: Missing Authentication header' });
    expect(hermesTextError('API call failed after 3 retries: HTTP 404: No endpoints found for .')?.code).toBe('runtime.apiError');
    expect(hermesTextError('I checked the HTTP 404: page and it is fine')).toBeNull();
    const { run, proc } = await runTurn({
      overrides: {
        'session/prompt': (msg) => [
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: DENY_SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HTTP 401: Missing Authentication header' } } } },
          { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } },
        ],
      },
    });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn' });
  });

  it('续话（真实录制）：resume 期间重放的历史不算本轮输出；只有 resume 应答之后的才算', async () => {
    const fixture = loadAcpFixture('hermes', 'real-resume-acp.jsonl');
    const resumedId = '32372d72-8435-4426-8ad7-488cc840ab8f';
    const ah = acpHarness(fixture);
    ah.h.fs.writeFile(path.join(HOME, '.clawopt-session.json'), JSON.stringify({ version: 1, sessionId: baseRequest().sessionId, nativeSessionId: resumedId, confirmed: true, fingerprint: { runtime: 'hermes', mode: 'global' }, updatedAt: '' }));
    const { run, proc, replay } = await runTurn({ h: ah, request: baseRequest({ resume: true }) });
    await closeWhenStdinEnds(proc);
    const outcome = await run.done as any;
    expect(methods(replay).slice(0, 3)).toEqual(['initialize', 'session/resume', 'session/prompt']);
    expect(replay.sent.find((m) => m.method === 'session/resume').params).toEqual({ sessionId: resumedId, cwd: WORKSPACE, mcpServers: [] });
    expect(outcome.kind).toBe('completed');
    expect(outcome.outputText).not.toContain('I have seen 1 user message');
    expect(outcome.outputText).toContain('2 user message');
  });

  it('resume 悄悄新建了会话（来历 id 对不上）：runtime.resumeFailed，不在错的会话上发 prompt', async () => {
    const ah = acpHarness(DENY, { 'session/resume': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { _meta: { hermes: { sessionProvenance: { acpSessionId: 'brand-new-session' } } } } }] });
    ah.h.fs.writeFile(path.join(HOME, '.clawopt-session.json'), JSON.stringify({ version: 1, sessionId: baseRequest().sessionId, nativeSessionId: 'old-session', confirmed: true, fingerprint: { runtime: 'hermes', mode: 'global' }, updatedAt: '' }));
    const { run, proc, replay } = await runTurn({ h: ah, request: baseRequest({ resume: true }) });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.resumeFailed' });
    expect(methods(replay)).not.toContain('session/prompt');
  });

  it('中止（真实录制）：流式 token 中途 session/cancel，prompt 以 cancelled 返回 → aborted', async () => {
    const fixture = loadAcpFixture('hermes', 'real-cancel-acp.jsonl');
    const promptBatch = recordedBatch(fixture, 'session/prompt');
    let promptId: number | null = null;
    const ah = acpHarness(fixture, { 'session/prompt': (msg) => { promptId = msg.id; return promptBatch.filter((m) => m.method); } });
    const { run, proc, replay } = await runTurn({ h: ah });
    await waitFor(() => run.canonical().some((e) => e.type === 'response.output_text.delta'));
    run.abort.abort();
    await waitFor(() => replay.sent.some((m) => m.method === 'session/cancel'));
    proc.line({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    expect(await run.done).toMatchObject({ kind: 'aborted', synced: true });
  });

  it('global 模型覆盖经 session/set_model；scoped 不发', async () => {
    const g = await runTurn({ request: baseRequest({ model: 'openrouter:anthropic/claude-sonnet-5' }), overrides: { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] } });
    await closeWhenStdinEnds(g.proc);
    await g.run.done;
    expect(g.replay.sent.find((m) => m.method === 'session/set_model').params).toEqual({ sessionId: DENY_SESSION, modelId: 'openrouter:anthropic/claude-sonnet-5' });
    const s = await runTurn({ request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER, model: 'x' }), mode: 'scoped', overrides: { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] } });
    await closeWhenStdinEnds(s.proc);
    await s.run.done;
    expect(methods(s.replay)).not.toContain('session/set_model');
  });

  it('Hermes 没有 session/close 能力（initialize 没声明）：不发 close，直接关 stdin', async () => {
    const { run, proc, replay } = await runTurn({ overrides: { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] } });
    await closeWhenStdinEnds(proc);
    await run.done;
    expect(methods(replay)).not.toContain('session/close');
    expect(proc.stdinEnded).toBe(true);
  });

  it('关了 stdin 进程不退：3 秒后停进程组（不让本轮挂住）', async () => {
    const { run, proc } = await runTurn({ overrides: { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] } });
    await waitFor(() => proc.stdinEnded);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(proc.terminateCalls).toBe(1);
    expect(await run.done).toMatchObject({ kind: 'completed' });
  }, 10_000);

  it('只有拒绝选项的权限请求：审批只给 deny；对端的 fs/* 请求回 -32601（没声明这些能力）', async () => {
    const { run, proc, replay } = await runTurn({
      overrides: {
        'session/prompt': (msg) => [
          { jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { sessionId: DENY_SESSION, path: '/etc/passwd' } },
          { jsonrpc: '2.0', id: 8, method: 'session/request_permission', params: { sessionId: DENY_SESSION, toolCall: { title: 'x' }, options: [{ optionId: 'deny', kind: 'reject_once' }] } },
          { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } },
        ],
      },
    });
    await waitFor(() => run.canonical().some((e) => e.type === 'approval.requested'));
    expect(replay.answers.find((a) => a.id === 7).error.code).toBe(-32601);
    expect((run.canonical().find((e) => e.type === 'approval.requested') as any).request.choices).toEqual(['deny']);
    expect(run.handle.resolveApproval!('acp:run_1:0', 'once')).toBe(true);
    await waitFor(() => replay.answers.some((a) => a.id === 8));
    expect(replay.answers.find((a) => a.id === 8).result, '没有「允许」选项时不能选出一个允许').toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    await closeWhenStdinEnds(proc);
    await run.done;
  });

  it('tool_call 自带终态（completed）时立刻出结果；整轮用量为 0 时不记', async () => {
    const { run, proc } = await runTurn({
      overrides: {
        'session/prompt': (msg) => [
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: DENY_SESSION, update: { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'read_file', status: 'completed', rawInput: { path: 'a' }, content: [{ type: 'content', content: { type: 'text', text: 'A' } }] } } },
          { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } } },
        ],
      },
    });
    await closeWhenStdinEnds(proc);
    await run.done;
    expect((run.canonical().find((e: any) => e.item?.type === 'function_call_output') as any).item).toMatchObject({ call_id: 't9', output: 'A', status: 'completed' });
    expect(run.canonical().some((e) => e.type === 'usage.reported')).toBe(false);
  });

  it('能力声明：真审批、原生续话与压缩、收图片；不声明澄清', () => {
    expect(createHermesAdapter(harness().deps).capabilities).toMatchObject({ approvals: true, clarify: false, nativeResume: true, nativeCompact: true, images: true, mcpInjection: true });
  });

  it('没安装：runtime.notInstalled；status 命令不支持', async () => {
    const h = harness();
    h.manager.missing = true;
    expect(await startRun(createHermesAdapter(h.deps), baseRequest()).done).toMatchObject({ code: 'runtime.notInstalled' });
    const h2 = harness();
    expect(await startRun(createHermesAdapter(h2.deps), baseRequest({ command: { kind: 'status' } })).done).toMatchObject({ code: 'runtime.commandUnsupported' });
  });

  it('scoped 下换了模型：session/new 而不是 resume', async () => {
    const ah = acpHarness(DENY, { 'session/prompt': (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }] });
    const first = await runTurn({ h: ah, request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    await closeWhenStdinEnds(first.proc);
    await first.run.done;
    const second = await runTurn({ h: ah, request: baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, model: 'other' } }), mode: 'scoped' });
    await closeWhenStdinEnds(second.proc);
    await second.run.done;
    expect(methods(second.replay)).toContain('session/new');
    expect(methods(second.replay)).not.toContain('session/resume');
  });
});

describe('Hermes：同轮双路事件仲裁', () => {
  it('scoped：代理 tee 的工具与文本丢掉、用量只信代理；ACP 的工具卡只有一张', async () => {
    const ah = acpHarness();
    const { coordinator, store, realtime, submitted, runId } = await submitThroughCoordinator(createHermesAdapter(ah.h.deps), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await ah.h.exec.next();
    ah.h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call_p', name: 'terminal', arguments: '{}' } });
    ah.h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'p', delta: 'proxy text' });
    ah.h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:h1', scope: 'model_call', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    await waitFor(() => realtime.some((e) => e.type === 'approval.requested'));
    coordinator.respondInteraction('session:s1', `acp:${submitted.run.runId}:0`, { choice: 'deny' });
    await closeWhenStdinEnds(proc);
    expect((await submitted.completion).outcome.kind).toBe('completed');
    expect(toolStartedIds(realtime)).toEqual(['tc-754bcd266a21']);
    expect(deltaText(realtime)).not.toContain('proxy text');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:h1']);
  });
});
