/**
 * DeepSeek Harness 适配器（ACP）。
 *
 * fixtures/real-*-acp.jsonl 是 `dsh` 0.1.5-rc.1（隔离安装）`--profile acp` 的真实往返：对本地假 Responses 上游的多轮（含 bash 工具与 /compact 文本）、
 * 没凭据时的 session/prompt 报错、跨进程 session/resume、以及 workspace-write 模式下的权限请求。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createDshAdapter, dshEffort } from '../../../../src/runtime/adapters/dsh';
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

const HOME = runtimeHomeDir(DATA_DIR, 'dsh', { kind: 'session', sessionKey: 'session:s1' });
const MOCK = loadAcpFixture('dsh', 'real-mock-acp.jsonl');
const MOCK_SESSION = 'ea8de142-401a-4d5a-b2dd-34d23ee0fd9d';

function acpHarness(fixture = MOCK, overrides: Parameters<typeof replayAcp>[2] = {}) {
  const replays: AcpReplay[] = [];
  const h = harness({ executorOptions: { onLaunch: (proc) => { replays.push(replayAcp(proc, fixture, overrides)); } } });
  return { h, replays };
}

async function runTurn(options: { fixture?: typeof MOCK; overrides?: Parameters<typeof replayAcp>[2]; request?: ReturnType<typeof baseRequest>; mode?: 'global' | 'scoped'; h?: ReturnType<typeof acpHarness> } = {}) {
  const ah = options.h ?? acpHarness(options.fixture, options.overrides);
  const run = startRun(createDshAdapter(ah.h.deps), options.request ?? baseRequest(), { proxyMode: options.mode });
  const proc = await ah.h.exec.next();
  return { ...ah, run, proc, replay: ah.replays[ah.replays.length - 1] };
}

/** 进程在关 stdin 后退出。 */
async function closeWhenStdinEnds(proc: Awaited<ReturnType<typeof runTurn>>['proc']) {
  for (let i = 0; i < 200 && !proc.stdinEnded; i += 1) await flushMicrotasks(1);
  proc.close(0);
}

const methods = (replay: AcpReplay) => replay.sent.filter((m) => m.method).map((m) => m.method);

describe('DSH：命令构造', () => {
  it('global：dsh --profile acp，关审批（DSH_PERMISSION_MODE=danger-full-access）、关遥测；stdin 留给 ACP；不写任何配置', async () => {
    const { proc, h } = await runTurn();
    expect(proc.spec.args).toEqual(['--profile', 'acp']);
    expect(proc.spec.env).toMatchObject({ DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1' });
    expect(proc.spec.env.DSH_HOME).toBeUndefined();
    expect(proc.spec.stdin).toBe('pipe');
    expect(writtenFiles(h.fs, HOME)).toEqual([]);
  });

  it('金样：scoped（settings.yaml 只放 clawopt 服务商、patch 指默认路由、AGENTS.md 托管块）', async () => {
    const { proc, h } = await runTurn({ request: baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, apiMode: 'responses', reasoningEffort: 'max' }, instructions: '托管规则' }), mode: 'scoped' });
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec })).toMatchFileSnapshot(goldenPath('dsh', 'scoped-launch.txt'));
  });

  it('**scoped：上游 key 与代理令牌都不进文件**；settings 里只有凭据引用 apiKeyEnv', async () => {
    const { proc, h } = await runTurn({ request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    const files = [...h.fs.files.values()].map((f) => f.content).join('\n');
    expect(files).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(files).not.toContain('clawopt_proxy_token');
    expect(files).toContain('apiKeyEnv: CLAWOPT_DSH_API_KEY');
    expect(proc.spec.env.CLAWOPT_DSH_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');
    expect(proc.spec.env.DSH_HOME).toBe(path.join(HOME, 'dsh-home'));
    expect(proc.spec.args).toEqual(['--profile', 'acp', '--patch', path.join(HOME, 'clawopt-acp.patch.yml')]);
  });

  it('global 放行 DEEPSEEK_* 凭据；scoped 不继承', async () => {
    const processEnv = { PATH: '/bin', DEEPSEEK_API_KEY: 'ds', SECRET_TOKEN: 's' };
    const g = acpHarness();
    g.h.deps.processEnv = processEnv;
    const global = await runTurn({ h: g });
    expect(global.proc.spec.env.DEEPSEEK_API_KEY).toBe('ds');
    expect(global.proc.spec.env.SECRET_TOKEN).toBeUndefined();
    const s = acpHarness();
    s.h.deps.processEnv = processEnv;
    const scoped = await runTurn({ h: s, request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    expect(scoped.proc.spec.env.DEEPSEEK_API_KEY).toBeUndefined();
  });
});

describe('DSH：ACP 往返（真实录制）', () => {
  it('initialize(protocolVersion 1) → session/new → session/prompt → session/close → 关 stdin；正文 ok、会话 id 确认', async () => {
    const { run, proc, replay } = await runTurn({ request: baseRequest({ instructions: '只回答结果' }) });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok', stopReason: 'end_turn' });
    expect(methods(replay)).toEqual(['initialize', 'session/new', 'session/prompt', 'session/close']);
    expect(replay.sent[0].params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect(replay.sent[1].params).toEqual({ cwd: WORKSPACE, mcpServers: [] });
    // global：指令作为第一个文本块（托管块包着），prompt 在后
    const blocks = replay.sent[2].params.prompt;
    expect(blocks[0].text).toContain('只回答结果');
    expect(blocks[0].text).toContain('BEGIN CLAWOPT PROMPT');
    expect(blocks[1]).toEqual({ type: 'text', text: 'reply with ok' });
    expect(run.canonical().find((e) => e.type === 'runtime.native_session')).toMatchObject({ nativeSessionId: MOCK_SESSION });
  });

  it('工具轮：思维、bash 一张卡、结果；global 下不记用量（usage_update 只是上下文占用）', async () => {
    const toolBatch = recordedBatch(MOCK, 'session/prompt', 1);
    const { run, proc } = await runTurn({ overrides: { 'session/prompt': () => toolBatch } });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    const events = run.canonical() as any[];
    expect(events.filter((e) => e.type === 'response.reasoning.delta').map((e) => e.delta).join('')).toBe('Thinking about running echo.');
    const calls = events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    expect(calls.map((e) => [e.item.call_id, e.item.name])).toEqual([['call_mock22|fc_mock22', 'bash']]);
    expect(events.find((e) => e.item?.type === 'function_call_output').item).toMatchObject({ status: 'completed', output: 'hi\n' });
    expect(events.some((e) => e.type === 'usage.reported')).toBe(false);
  });

  it('权限请求（录制里是 workspace-write 下的越权命令）：自动选「允许一次」', async () => {
    const fixture = loadAcpFixture('dsh', 'real-permission-acp.jsonl');
    const { run, proc, replay } = await runTurn({ fixture });
    await closeWhenStdinEnds(proc);
    await run.done;
    expect(replay.answers).toEqual([{ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }]);
    expect(run.canonical().some((e) => e.type === 'approval.requested')).toBe(false);
  });

  it('没凭据：session/prompt 回 -32603 no API key → runtime.notLoggedIn', async () => {
    const fixture = loadAcpFixture('dsh', 'real-no-credentials-acp.jsonl');
    const { run, proc } = await runTurn({ fixture });
    await closeWhenStdinEnds(proc);
    const outcome = await run.done as any;
    expect(outcome).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn' });
    expect(outcome.error).toContain('no API key');
  });

  it('续话：session/resume 带着记下的会话 id；resume 报错不偷偷新建（runtime.resumeFailed）', async () => {
    const ah = acpHarness(MOCK);
    const first = await runTurn({ h: ah });
    await closeWhenStdinEnds(first.proc);
    await first.run.done;
    const resumeFixture = loadAcpFixture('dsh', 'real-resume-acp.jsonl');
    const ok = acpHarness(resumeFixture);
    ok.h.deps.fs = ah.h.deps.fs;
    const second = await runTurn({ h: ok, request: baseRequest({ resume: true }) });
    await closeWhenStdinEnds(second.proc);
    await second.run.done;
    expect(methods(second.replay)).toContain('session/resume');
    expect(second.replay.sent.find((m) => m.method === 'session/resume').params).toEqual({ sessionId: MOCK_SESSION, cwd: WORKSPACE, mcpServers: [] });
    expect(methods(second.replay)).not.toContain('session/new');

    const bad = acpHarness(MOCK, { 'session/resume': (msg) => [{ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `session is not resumable: ${MOCK_SESSION}` } }] });
    bad.h.deps.fs = ah.h.deps.fs;
    const third = await runTurn({ h: bad, request: baseRequest({ resume: true }) });
    await closeWhenStdinEnds(third.proc);
    expect(await third.run.done).toMatchObject({ kind: 'failed', code: 'runtime.resumeFailed' });
    expect(methods(third.replay)).not.toContain('session/new');
  });

  it('scoped：session/set_config_option 选模型（JSON 数组字符串）与推理强度；托管 MCP 进 session/new', async () => {
    const ah = acpHarness(MOCK);
    ah.h.deps.mcp = { resolveForRun: async () => ({ servers: [{ name: 'api', transport: 'stdio', command: 'node', args: ['m.mjs'], env: { K: 'v' } }, { name: 'web', transport: 'http', url: 'https://m', headers: { A: 'b' } }], excluded: [] }) };
    const { run, proc, replay } = await runTurn({ h: ah, request: baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, reasoningEffort: 'high' } }), mode: 'scoped' });
    await closeWhenStdinEnds(proc);
    await run.done;
    const configs = replay.sent.filter((m) => m.method === 'session/set_config_option').map((m) => [m.params.configId, m.params.value]);
    expect(configs).toEqual([['model', JSON.stringify(['clawopt', 'deepseek-v4'])], ['reasoning_effort', 'high']]);
    expect(replay.sent.find((m) => m.method === 'session/new').params.mcpServers).toEqual([
      { name: 'api', command: 'node', args: ['m.mjs'], env: [{ name: 'K', value: 'v' }] },
      { type: 'http', name: 'web', url: 'https://m', headers: [{ name: 'A', value: 'b' }] },
    ]);
    expect(replay.sent.find((m) => m.method === 'session/prompt').params.prompt).toEqual([{ type: 'text', text: 'reply with ok' }]);
  });

  it('配置失败（上游不认这个推理强度）只记日志，本轮照跑', async () => {
    const ah = acpHarness(MOCK, { 'session/set_config_option': (msg) => [{ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: unknown reasoning effort' } }] });
    const { run, proc } = await runTurn({ h: ah, request: baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, reasoningEffort: 'high' } }), mode: 'scoped' });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'completed' });
    expect(ah.h.logs.some((l) => l.level === 'warn' && l.message.includes('ACP 配置失败'))).toBe(true);
  });

  it('全新 DSH_HOME 首次启动：session/new 先报 no adapter registered，隔一秒重试成功', async () => {
    let calls = 0;
    const newBatch = recordedBatch(MOCK, 'session/new');
    const ah = acpHarness(MOCK, {
      'session/new': (msg) => (calls++ === 0 ? [{ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'no adapter registered for provider "clawopt"' } } }] : newBatch),
    });
    const { run, proc } = await runTurn({ h: ah });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'completed' });
    expect(calls).toBe(2);
  }, 10_000);

  it('协议版本不是 1：runtime.protocolError', async () => {
    const { run, proc } = await runTurn({ overrides: { initialize: (msg) => [{ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 2 } }] } });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.protocolError' });
  });

  it('只收自己会话的更新；stopReason 不是正常结束判失败', async () => {
    const { run, proc } = await runTurn({
      overrides: {
        'session/prompt': (msg) => [
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'someone-else', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'not mine' } } } },
          { jsonrpc: '2.0', method: 'session/update', params: { sessionId: MOCK_SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mine' } } } },
          { jsonrpc: '2.0', id: msg.id, result: { stopReason: 'refusal' } },
        ],
      },
    });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'failed', stopReason: 'refusal' });
    expect(run.canonical().filter((e) => e.type === 'response.output_text.delta').map((e: any) => e.delta)).toEqual(['mine']);
  });

  it('进程在本轮结束前退出：失败并带上 stderr', async () => {
    const { run, proc } = await runTurn({ overrides: { 'session/prompt': () => [] } });
    await flushMicrotasks(20);
    proc.stderr('dsh: crashed\n');
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.exitNonZero' });
  });

  it('中止：发 session/cancel 通知，再停进程组，close 后 aborted', async () => {
    const { run, proc, replay } = await runTurn({ overrides: { 'session/prompt': () => [] } });
    await flushMicrotasks(20);
    run.abort.abort();
    await flushMicrotasks();
    expect(replay.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: MOCK_SESSION } });
    expect(proc.terminateCalls).toBeGreaterThan(0);
    expect(await run.done).toMatchObject({ kind: 'aborted', synced: true });
  });

  it('exit 先到：应答在 exit 之后才读到，也以 close 为准', async () => {
    let promptId: number | null = null;
    const { run, proc } = await runTurn({ overrides: { 'session/prompt': (msg) => { promptId = msg.id; return []; } } });
    await flushMicrotasks(20);
    proc.exit(0);
    proc.line({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: MOCK_SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late ok' } } } });
    proc.line({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    await closeWhenStdinEnds(proc);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'late ok' });
  });
});

describe('DSH：能力、续话兼容、错误', () => {
  it('能力声明：不开审批、不收图片（initialize 实测 image=false）、不支持原生压缩', () => {
    expect(createDshAdapter(harness().deps).capabilities).toMatchObject({ approvals: false, images: false, nativeCompact: false, nativeResume: true, mcpInjection: true });
  });

  it('/compact 不支持（ACP 下只是普通文本）：不起进程', async () => {
    const h = harness();
    expect(await startRun(createDshAdapter(h.deps), baseRequest({ command: { kind: 'compact' } })).done).toMatchObject({ code: 'runtime.commandUnsupported' });
    expect(h.exec.processes).toHaveLength(0);
  });

  it('scoped 下换了模型：session/new 而不是 resume', async () => {
    const ah = acpHarness(MOCK);
    const first = await runTurn({ h: ah, request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    await closeWhenStdinEnds(first.proc);
    await first.run.done;
    const second = await runTurn({ h: ah, request: baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, model: 'deepseek-v5' } }), mode: 'scoped' });
    await closeWhenStdinEnds(second.proc);
    await second.run.done;
    expect(methods(second.replay)).toContain('session/new');
    expect(methods(second.replay)).not.toContain('session/resume');
  });

  it('推理强度映射：max → xhigh、none → off、default 与认不出的不设；设了才在模型上声明档位', async () => {
    expect([dshEffort('max'), dshEffort('none'), dshEffort('default'), dshEffort('turbo'), dshEffort('low')]).toEqual(['xhigh', 'off', null, null, 'low']);
    const withEffort = await runTurn({ request: baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, reasoningEffort: 'high' } }), mode: 'scoped' });
    expect(withEffort.h.fs.readText(path.join(HOME, 'dsh-home', 'settings.yaml'))).toContain('reasoningEfforts:\n            high: high');
    const without = await runTurn({ request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    expect(without.h.fs.readText(path.join(HOME, 'dsh-home', 'settings.yaml'))).not.toContain('reasoningEfforts');
  });

  it('global 没有指令时 prompt 只有一个文本块', async () => {
    const { run, proc, replay } = await runTurn();
    await closeWhenStdinEnds(proc);
    await run.done;
    expect(replay.sent.find((m) => m.method === 'session/prompt').params.prompt).toEqual([{ type: 'text', text: 'reply with ok' }]);
  });

  it('scoped 收尾撤销代理目标、释放运行计数', async () => {
    const { run, proc, h } = await runTurn({ request: baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), mode: 'scoped' });
    await closeWhenStdinEnds(proc);
    await run.done;
    expect(h.proxy.revoked).toBe(1);
    expect(h.manager.runsEnded).toBe(1);
  });

  it('dsh 没安装：runtime.notInstalled', async () => {
    const h = harness();
    h.manager.missing = true;
    expect(await startRun(createDshAdapter(h.deps), baseRequest()).done).toMatchObject({ code: 'runtime.notInstalled' });
  });
});

describe('DSH：同轮双路事件仲裁', () => {
  it('scoped：代理 tee 的文本与工具丢掉，只信 ACP；用量只信代理', async () => {
    const ah = acpHarness(MOCK, { 'session/prompt': () => recordedBatch(MOCK, 'session/prompt', 1) });
    const { store, realtime, submitted, runId } = await submitThroughCoordinator(createDshAdapter(ah.h.deps), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await ah.h.exec.next();
    ah.h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'p', delta: 'ok' });
    ah.h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call_mock22', name: 'bash', arguments: '{}' } });
    ah.h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:d1', scope: 'model_call', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    await closeWhenStdinEnds(proc);
    await submitted.completion;
    expect(toolStartedIds(realtime)).toEqual(['call_mock22|fc_mock22']);
    expect(deltaText(realtime)).toBe('ok');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:d1']);
  });
});
