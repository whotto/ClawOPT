/**
 * Grok 适配器。
 *
 * fixtures：`grok` 1.0.30（隔离安装）的真实 streaming-json——
 * real-mock-tool-turn.jsonl 是对本地假 Responses 上游跑的一轮（带一次终端工具）；real-not-signed-in.jsonl 是没登录时的输出。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createGrokAdapter } from '../../../../src/runtime/adapters/grok';
import { deltaText, submitThroughCoordinator, toolStartedIds } from '../_helpers/coordinator';
import {
  DATA_DIR,
  homeFor,
  SCOPED_PROVIDER,
  USER_HOME,
  WORKSPACE,
  baseRequest,
  flushMicrotasks,
  goldenPath,
  harness,
  readFixtureLines,
  renderLaunch,
  startRun,
  writtenFiles,
} from '../_helpers/harness';

const HOME = homeFor('grok');
const HANDLE = '11111111-1111-4111-8111-111111111111';

async function launched(h = harness(), request = baseRequest(), proxyMode?: 'global' | 'scoped') {
  const adapter = createGrokAdapter(h.deps);
  const run = startRun(adapter, request, { proxyMode });
  const proc = await h.exec.next();
  return { h, adapter, run, proc };
}

const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('Grok：命令构造', () => {
  it('prompt 写进一次性文件经 --prompt-file 传入，不进 argv；stdin 不用；headless 参数齐全', async () => {
    const { proc, h } = await launched();
    const args = proc.spec.args;
    expect(args.slice(0, 4)).toEqual(['--output-format', 'streaming-json', '--always-approve', '--no-auto-update']);
    expect(args).not.toContain('reply with ok');
    const promptFile = arg(args, '--prompt-file');
    expect(promptFile).toBe(path.join(HOME, 'turn-prompt-run_1.md'));
    expect(h.fs.readText(promptFile)).toBe('reply with ok');
    expect(proc.spec.stdin).toBe('ignore');
    expect(arg(args, '--cwd')).toBe(WORKSPACE);
    expect(proc.spec.env.GROK_DISABLE_AUTOUPDATER).toBe('1');
  });

  it('收尾删掉一次性 prompt 文件', async () => {
    const { proc, h, run } = await launched();
    const promptFile = arg(proc.spec.args, '--prompt-file');
    proc.line({ type: 'end', stopReason: 'end_turn', sessionId: HANDLE });
    proc.close(0);
    await run.done;
    expect(h.fs.readText(promptFile)).toBeNull();
  });

  it('首轮 --session-id 用预生成 id', async () => {
    const { proc } = await launched();
    expect(arg(proc.spec.args, '--session-id')).toBe(HANDLE);
    expect(proc.spec.args).not.toContain('--resume');
  });

  it('**本地没有会话目录时绝不 --resume**（Grok 会进交互式设备码登录挂住），改用 --session-id 新建', async () => {
    const h = harness();
    const first = await launched(h);
    first.proc.line({ type: 'end', stopReason: 'end_turn', sessionId: HANDLE });
    first.proc.close(0);
    await first.run.done;
    // 状态说已确认，但 ~/.grok/sessions 里没有这个 id
    const second = await launched(h, baseRequest({ resume: true }));
    expect(second.proc.spec.args).not.toContain('--resume');
    expect(arg(second.proc.spec.args, '--session-id')).toBe(HANDLE);
  });

  it('会话目录存在（按工作区编码的桶，或任一哈希桶）时 --resume', async () => {
    const h = harness();
    h.fs.seedDir(`${USER_HOME}/.grok/sessions/${encodeURIComponent(WORKSPACE)}/${HANDLE}`);
    const byWorkspace = await launched(h, baseRequest({ resume: true }));
    expect(arg(byWorkspace.proc.spec.args, '--resume')).toBe(HANDLE);

    const hashed = harness();
    hashed.fs.seedDir(`${USER_HOME}/.grok/sessions/ab12cd34/${HANDLE}`);
    const byBucket = await launched(hashed, baseRequest({ resume: true }));
    expect(arg(byBucket.proc.spec.args, '--resume')).toBe(HANDLE);
  });

  it('global：短指令经 --rules；超过 4 KiB 的指令写进 prompt 文件前言，不进 argv', async () => {
    const short = await launched(harness(), baseRequest({ instructions: '用中文' }));
    expect(arg(short.proc.spec.args, '--rules')).toBe('用中文');

    const long = 'x'.repeat(5000);
    const big = await launched(harness(), baseRequest({ instructions: long }));
    expect(big.proc.spec.args).not.toContain('--rules');
    expect(big.proc.spec.args.some((a) => a.includes('xxxxxxxx'))).toBe(false);
    expect(big.h.fs.readText(arg(big.proc.spec.args, '--prompt-file'))).toContain(long);
  });

  it('**global 不做影子 GROK_HOME**：不设 GROK_HOME、不写任何配置文件；放行 XAI_* 凭据', async () => {
    const { proc, h } = await launched(harness({ processEnv: { PATH: '/bin', XAI_API_KEY: 'xai-user', SECRET_TOKEN: 's' } }));
    expect(proc.spec.env.GROK_HOME).toBeUndefined();
    expect(proc.spec.env.XAI_API_KEY).toBe('xai-user');
    expect(proc.spec.env.SECRET_TOKEN).toBeUndefined();
    expect([...h.fs.files.keys()].filter((p) => !p.includes('turn-prompt') && !p.endsWith('.clawopt-session.json'))).toEqual([]);
  });

  it('金样：global', async () => {
    const h = harness();
    const { proc } = await launched(h, baseRequest({ model: 'grok-code-fast', reasoningEffort: 'high', instructions: '规则' }));
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec })).toMatchFileSnapshot(goldenPath('grok', 'global-launch.txt'));
  });

  it('金样：scoped（config.toml 模型指向代理、旁路调用也走 clawopt、身份说明、托管 MCP）', async () => {
    const h = harness({ mcpServers: [{ name: 'clawopt-api', transport: 'stdio', command: 'node', args: ['mcp.mjs'] }] });
    h.fs.seed(`${USER_HOME}/.grok/config.toml`, 'default = "grok-4"\napi_key = "xai-secret"\n\n[ui]\nscreen_mode = "minimal"\n\n[model.old]\nbase_url = "https://x"\n\n[cli]\nauto_update = true\n');
    h.fs.seed(`${USER_HOME}/.grok/AGENTS.md`, '# 用户 Grok 指令');
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, apiMode: 'responses', reasoningEffort: 'low' }, instructions: '托管规则' }), 'scoped');
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME).filter((f) => !f.path.includes('turn-prompt')), spec: proc.spec })).toMatchFileSnapshot(goldenPath('grok', 'scoped-launch.txt'));
  });

  it('**scoped：上游 key、代理令牌、用户的 api_key 都不进生成的文件**', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.grok/config.toml`, 'api_key = "xai-secret-value"\n');
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const generated = [...h.fs.files.entries()].filter(([p]) => p.startsWith(DATA_DIR)).map(([, f]) => f.content).join('\n');
    expect(generated).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(generated).not.toContain('clawopt_proxy_token');
    expect(generated).not.toContain('xai-secret-value');
    expect(proc.spec.env.CLAWOPT_GROK_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');
    expect(proc.spec.env.GROK_HOME).toBe(path.join(HOME, 'grok-home'));
  });

  it('scoped 子进程环境不继承用户的 XAI_API_KEY（残留登录不能盖过代理）', async () => {
    const { proc } = await launched(harness({ processEnv: { PATH: '/bin', XAI_API_KEY: 'xai-user', GROK_HOME: '/home/user/.grok' } }), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    expect(proc.spec.env.XAI_API_KEY).toBeUndefined();
    expect(proc.spec.env.GROK_HOME).toBe(path.join(HOME, 'grok-home'));
  });

  it('能力声明：不收图片（--prompt-json 走 argv 会撞 ARG_MAX）、不开审批（--always-approve）', async () => {
    const adapter = createGrokAdapter(harness().deps);
    expect(adapter.capabilities).toMatchObject({ images: false, approvals: false, clarify: false, nativeResume: true, nativeCompact: true });
  });

  it('/compact 作为一轮发出（写进 prompt 文件）；status 不支持', async () => {
    const compact = await launched(harness(), baseRequest({ command: { kind: 'compact', instructions: '保留要点' } }));
    expect(compact.h.fs.readText(arg(compact.proc.spec.args, '--prompt-file'))).toBe('/compact 保留要点');
    const h = harness();
    expect(await startRun(createGrokAdapter(h.deps), baseRequest({ command: { kind: 'status' } })).done).toMatchObject({ code: 'runtime.commandUnsupported' });
  });
});

describe('Grok：解析真实 streaming-json', () => {
  it('工具轮：思维、终端工具一张卡（只在终态出结果）、正文 ok、end 给会话 id 与按模型的用量', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('grok', 'real-mock-tool-turn.jsonl'));
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok', stopReason: 'end_turn' });
    const events = run.canonical() as any[];
    expect(events.filter((e) => e.type === 'response.reasoning.delta').map((e) => e.delta).join('')).toBe('Thinking about running echo.');
    const calls = events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    expect(calls.map((e) => [e.item.call_id, e.item.name])).toEqual([['call_mock13', 'run_terminal_command']]);
    const outputs = events.filter((e) => e.item?.type === 'function_call_output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].item).toMatchObject({ output: 'hi\n', status: 'completed' });
    expect(events.find((e) => e.type === 'runtime.native_session').nativeSessionId).toBe('01a0a32b-958c-71b1-b203-10eb1b37c145');
    const usage = events.filter((e) => e.type === 'usage.reported').map((e) => e.usage);
    expect(usage).toEqual([expect.objectContaining({ callId: 'grok:01a0a32b-958c-71b1-b203-10eb1b37c145:f84847b7-de76-4ad2-8b81-c79a7adac81d', model: 'mock-model', inputTokens: 30, outputTokens: 6, reasoningTokens: 3, apiCalls: 2 })]);
  });

  it('没登录：error 事件 → runtime.notLoggedIn（0.4 秒就退出，不挂）', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('grok', 'real-not-signed-in.jsonl'));
    proc.close(1);
    const outcome = await run.done as any;
    expect(outcome).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn' });
    expect(outcome.error).toContain('Not signed in');
  });

  it('plan → plan.updated；available_commands / auto_compact_* 忽略', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'available_commands', tools: [] });
    proc.line({ type: 'auto_compact_started', percentage: 85 });
    proc.line({ type: 'plan', entries: [{ content: '读代码' }, { title: '改测试' }] });
    proc.line({ type: 'end', stopReason: 'end_turn' });
    proc.close(0);
    await run.done;
    expect(run.canonical().find((e) => e.type === 'plan.updated')).toMatchObject({ plan: { entries: ['读代码', '改测试'] } });
  });

  it('失败的工具更新记为 failed；非终态更新不出结果', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'tool_call', toolCallId: 't1', toolName: 'search_replace', rawInput: { path: 'a' } });
    proc.line({ type: 'tool_call_update', toolCallId: 't1', status: 'in_progress', content: [] });
    proc.line({ type: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'no match' } }] });
    proc.line({ type: 'end', stopReason: 'end_turn' });
    proc.close(0);
    await run.done;
    const outputs = run.canonical().filter((e: any) => e.item?.type === 'function_call_output') as any[];
    expect(outputs.map((e) => [e.item.status, e.item.output])).toEqual([['failed', 'no match']]);
  });

  it('崩在 end 之前：把逐次 usage 加起来记一行；退出码非 0 判失败', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } });
    proc.line({ type: 'usage', usage: { input_tokens: 7, output_tokens: 2 } });
    proc.line({ type: 'error', message: 'upstream 500' });
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.apiError' });
    expect((run.canonical().find((e) => e.type === 'usage.reported') as any).usage).toMatchObject({ inputTokens: 12, outputTokens: 3, apiCalls: 2 });
  });

  it('没有 end 但退出码 0：算完成', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'text', data: 'partial ok' });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'partial ok' });
  });

  it('end 的 stopReason 不是正常结束：判失败', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'end', stopReason: 'refusal' });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'failed', stopReason: 'refusal' });
  });
});

describe('Grok：close、中止、续话、错误', () => {
  it('exit 先到：end 在 exit 之后才读到，也算', async () => {
    const { run, proc } = await launched();
    proc.exit(0);
    await flushMicrotasks();
    proc.line({ type: 'text', data: 'ok' });
    proc.line({ type: 'end', stopReason: 'end_turn', sessionId: HANDLE, usage: { input_tokens: 1, output_tokens: 1 } });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    expect(run.types()).toContain('usage.reported');
  });

  it('中止：停进程组，close 后 aborted；prompt 文件照样清掉', async () => {
    const { run, proc, h } = await launched();
    const promptFile = arg(proc.spec.args, '--prompt-file');
    run.abort.abort();
    expect(await run.done).toMatchObject({ kind: 'aborted', synced: true });
    expect(proc.terminateCalls).toBe(1);
    expect(h.fs.readText(promptFile)).toBeNull();
  });

  it('scoped 下换模型：不续旧会话，另起新 id', async () => {
    const h = harness();
    const first = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    first.proc.line({ type: 'end', stopReason: 'end_turn', sessionId: HANDLE });
    first.proc.close(0);
    await first.run.done;
    h.fs.seedDir(path.join(HOME, 'grok-home', 'sessions', encodeURIComponent(WORKSPACE), HANDLE));
    const second = await launched(h, baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, model: 'other' } }), 'scoped');
    expect(second.proc.spec.args).not.toContain('--resume');
    expect(arg(second.proc.spec.args, '--session-id')).not.toBe(HANDLE);
  });

  it('scoped 同模型、会话目录在运行时 home 里：--resume', async () => {
    const h = harness();
    const first = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    first.proc.line({ type: 'end', stopReason: 'end_turn', sessionId: HANDLE });
    first.proc.close(0);
    await first.run.done;
    h.fs.seedDir(path.join(HOME, 'grok-home', 'sessions', encodeURIComponent(WORKSPACE), HANDLE));
    const second = await launched(h, baseRequest({ mode: 'scoped', resume: true, provider: SCOPED_PROVIDER }), 'scoped');
    expect(arg(second.proc.spec.args, '--resume')).toBe(HANDLE);
  });

  it('没安装：runtime.notInstalled；网关错误文本：runtime.apiError', async () => {
    const missing = harness();
    missing.manager.missing = true;
    expect(await startRun(createGrokAdapter(missing.deps), baseRequest()).done).toMatchObject({ code: 'runtime.notInstalled' });
    const { run, proc } = await launched();
    proc.line({ type: 'text', data: 'API Error: 401 invalid key' });
    proc.line({ type: 'end', stopReason: 'end_turn' });
    proc.close(0);
    expect(await run.done).toMatchObject({ code: 'runtime.apiError' });
  });
});

describe('Grok：同轮双路事件仲裁', () => {
  it('scoped：代理 tee 的文本与工具都丢，只信 CLI；用量只信代理', async () => {
    const h = harness();
    const { store, realtime, submitted, runId } = await submitThroughCoordinator(createGrokAdapter(h.deps), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await h.exec.next();
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'p', delta: 'ok' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call_p', name: 'run_terminal_command', arguments: '{}' } });
    h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:g1', scope: 'model_call', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    proc.lines(readFixtureLines('grok', 'real-mock-tool-turn.jsonl'));
    proc.close(0);
    await submitted.completion;
    expect(toolStartedIds(realtime)).toEqual(['call_mock13']);
    expect(deltaText(realtime)).toBe('ok');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:g1']);
  });
});
