/**
 * OpenCode 适配器。
 *
 * fixtures：`opencode` 1.18.31（隔离安装）的真实 `run --format json`——
 * real-mock-tool-turn.jsonl 对本地假 Responses 上游（带 bash 工具与思维）；real-free-model-turn.jsonl 是没配服务商时
 * 回落到内置免费模型的一轮；real-unknown-model-error.jsonl 是指定了没配置的模型时的错误行。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createOpenCodeAdapter } from '../../../../src/runtime/adapters/opencode';
import { runtimeHomeDir } from '../../../../src/runtime/adapters/_shared/runtime-home';
import { deltaText, submitThroughCoordinator, toolStartedIds } from '../_helpers/coordinator';
import {
  DATA_DIR,
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

const HOME = runtimeHomeDir(DATA_DIR, 'opencode', { kind: 'session', sessionKey: 'session:s1' });
const MOCK_SESSION = 'ses_f5cd52c80ffeaj8InlmTYu5FjU';

async function launched(h = harness(), request = baseRequest(), proxyMode?: 'global' | 'scoped') {
  const adapter = createOpenCodeAdapter(h.deps);
  const run = startRun(adapter, request, { proxyMode });
  const proc = await h.exec.next();
  return { h, adapter, run, proc };
}

const runtimeConfig = (env: NodeJS.ProcessEnv) => JSON.parse(env.OPENCODE_CONFIG_CONTENT!);

async function firstTurn(h: ReturnType<typeof harness>, request = baseRequest(), mode: 'global' | 'scoped' = 'global') {
  const first = await launched(h, request, mode);
  first.proc.lines(readFixtureLines('opencode', 'real-mock-tool-turn.jsonl'));
  first.proc.close(0);
  await first.run.done;
}

describe('OpenCode：命令构造', () => {
  it('run --format json --auto --thinking；**prompt 走 stdin、没有位置参数**（位置参数带空格会被加上字面引号）', async () => {
    const { proc } = await launched(harness(), baseRequest({ prompt: 'reply with ok' }));
    expect(proc.spec.args).toEqual(['run', '--format', 'json', '--auto', '--thinking']);
    expect(proc.stdin).toBe('reply with ok');
    expect(proc.stdinEnded).toBe(true);
    expect(proc.spec.cwd).toBe(WORKSPACE);
  });

  it('运行时配置经 OPENCODE_CONFIG_CONTENT：权限全放行、关自动更新与分享；global 不设 OPENCODE_DB（用户自己的会话库）', async () => {
    const { proc } = await launched();
    expect(runtimeConfig(proc.spec.env)).toMatchObject({ autoupdate: false, share: 'disabled', permission: { '*': 'allow' } });
    expect(proc.spec.env.OPENCODE_DB).toBeUndefined();
    expect(proc.spec.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(proc.spec.env.HOME).toBe(USER_HOME);
    expect(proc.spec.env.XDG_CONFIG_HOME, '不重定向 XDG').toBeUndefined();
  });

  it('指令写进运行时 home 的规则文件，路径并进用户已有的 instructions', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.config/opencode/opencode.json`, JSON.stringify({ instructions: ['CONTRIBUTING.md'] }));
    const { proc } = await launched(h, baseRequest({ groupSystemPrompt: '群设定' }));
    const rules = path.join(HOME, 'clawopt-rules.md');
    expect(runtimeConfig(proc.spec.env).instructions).toEqual(['CONTRIBUTING.md', rules]);
    expect(h.fs.readText(rules)).toContain('群设定');
  });

  it('托管 MCP：stdio → local（命令数组 + environment），http → remote', async () => {
    const h = harness({ mcpServers: [{ name: 'a', transport: 'stdio', command: 'node', args: ['x.mjs'], env: { K: 'v' } }, { name: 'b', transport: 'http', url: 'https://m/x', headers: { H: '1' } }] });
    const { proc } = await launched(h);
    expect(runtimeConfig(proc.spec.env).mcp).toEqual({
      a: { type: 'local', command: ['node', 'x.mjs'], environment: { K: 'v' }, enabled: true },
      b: { type: 'remote', url: 'https://m/x', headers: { H: '1' }, enabled: true },
    });
  });

  it('金样：global（模型、推理强度、图片）', async () => {
    const h = harness();
    const { proc } = await launched(h, baseRequest({ model: 'anthropic/claude-sonnet-5', reasoningEffort: 'high', images: [{ path: '/tmp/shot.png', mimeType: 'image/png' }], instructions: '规则' }));
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('opencode', 'global-launch.txt'));
  });

  it('金样：scoped（只启用 clawopt 服务商、会话库按对话隔离、令牌走 {env:…}）', async () => {
    const h = harness();
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, apiMode: 'responses' } }), 'scoped');
    const env = { ...proc.spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(runtimeConfig(proc.spec.env), null, 2) };
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: { ...proc.spec, env }, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('opencode', 'scoped-launch.txt'));
  });

  it('**scoped：enabled_providers 只留 clawopt**（否则没配好时悄悄回落到免费模型）；上游 key 与令牌都不进配置内容', async () => {
    const { proc } = await launched(harness(), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const content = proc.spec.env.OPENCODE_CONFIG_CONTENT!;
    expect(runtimeConfig(proc.spec.env).enabled_providers).toEqual(['clawopt']);
    expect(content).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(content).not.toContain('clawopt_proxy_token');
    expect(content).toContain('{env:CLAWOPT_OPENCODE_API_KEY}');
    expect(proc.spec.env.CLAWOPT_OPENCODE_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');
    expect(proc.spec.env.OPENCODE_DB).toBe(path.join(HOME, 'opencode.db'));
    expect(proc.spec.env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1');
  });

  it('global 放行服务商凭据变量；scoped 不继承', async () => {
    const processEnv = { PATH: '/bin', ANTHROPIC_API_KEY: 'a', SECRET_TOKEN: 's' };
    const global = await launched(harness({ processEnv }));
    expect(global.proc.spec.env.ANTHROPIC_API_KEY).toBe('a');
    expect(global.proc.spec.env.SECRET_TOKEN).toBeUndefined();
    const scoped = await launched(harness({ processEnv }), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    expect(scoped.proc.spec.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('续话：-s <观察到的 sessionID>', async () => {
    const h = harness();
    await firstTurn(h);
    const { proc } = await launched(h, baseRequest({ resume: true }));
    expect(proc.spec.args[proc.spec.args.indexOf('-s') + 1]).toBe(MOCK_SESSION);
  });

  it('多张图片各自一个 --file（--file 吃数组，所以 prompt 绝不能跟在它后面当位置参数）', async () => {
    const { proc } = await launched(harness(), baseRequest({ images: [{ path: '/a.png', mimeType: 'image/png' }, { path: '/b.jpg', mimeType: 'image/jpeg' }] }));
    expect(proc.spec.args.slice(-4)).toEqual(['--file', '/a.png', '--file', '/b.jpg']);
    expect(proc.stdin).toBe('reply with ok');
  });

  it('没有指令时不写规则文件、配置里也没有 instructions', async () => {
    const { proc, h } = await launched();
    expect(runtimeConfig(proc.spec.env).instructions).toBeUndefined();
    expect(h.fs.readText(path.join(HOME, 'clawopt-rules.md'))).toBeNull();
  });

  it('用户配置是带注释的 opencode.jsonc 也能取到已有 instructions', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.config/opencode/opencode.jsonc`, '// 我的配置\n{ "instructions": ["docs/rules.md"] }');
    const { proc } = await launched(h, baseRequest({ instructions: 'x' }));
    expect(runtimeConfig(proc.spec.env).instructions[0]).toBe('docs/rules.md');
  });

  it('能力声明：不支持原生压缩、没有审批通道（--auto）', () => {
    expect(createOpenCodeAdapter(harness().deps).capabilities).toMatchObject({ nativeCompact: false, approvals: false, clarify: false, images: true, mcpInjection: true });
  });

  it('/compact 与 status 不支持：不起进程', async () => {
    const h = harness();
    const adapter = createOpenCodeAdapter(h.deps);
    expect(await startRun(adapter, baseRequest({ command: { kind: 'compact' } })).done).toMatchObject({ code: 'runtime.commandUnsupported' });
    expect(await startRun(adapter, baseRequest({ command: { kind: 'status' } })).done).toMatchObject({ code: 'runtime.commandUnsupported' });
    expect(h.exec.processes).toHaveLength(0);
  });
});

describe('OpenCode：解析真实 JSON 事件', () => {
  it('工具轮：思维、bash 一张卡（done + output 一次给出）、正文 ok、每步一行用量', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('opencode', 'real-mock-tool-turn.jsonl'));
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    const events = run.canonical() as any[];
    expect(events.find((e) => e.type === 'runtime.native_session').nativeSessionId).toBe(MOCK_SESSION);
    expect(events.filter((e) => e.type === 'response.reasoning.delta').map((e) => e.delta).join('')).toBe('Thinking about running echo.');
    const calls = events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    expect(calls.map((e) => [e.item.call_id, e.item.name, JSON.parse(e.item.arguments).command])).toEqual([['call_mock2', 'bash', 'echo hi']]);
    expect(events.find((e) => e.item?.type === 'function_call_output').item).toMatchObject({ output: 'hi\n', status: 'completed' });
    const usage = events.filter((e) => e.type === 'usage.reported').map((e) => e.usage);
    expect(usage.map((u) => [u.callId, u.inputTokens, u.outputTokens, u.reasoningTokens])).toEqual([
      [`opencode:${MOCK_SESSION}:prt_0a32ad744001f9gXHeSos6hzqP`, 20, 2, 3],
      [`opencode:${MOCK_SESSION}:prt_0a32ad755001cfWnJU5BA8UNGd`, 10, 1, 0],
    ]);
  });

  it('免费模型回落的一轮：缓存读取 token 进 cacheReadTokens', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('opencode', 'real-free-model-turn.jsonl'));
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    expect((run.canonical().find((e) => e.type === 'usage.reported') as any).usage).toMatchObject({ inputTokens: 9080, cacheReadTokens: 1792, outputTokens: 14 });
  });

  it('错误行（没配置的模型）：runtime.apiError，详情带上 stderr 里的真实原因', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('opencode', 'real-unknown-model-error.jsonl'));
    proc.stderr('ProviderModelNotFoundError: Model not found: openai/gpt-5\n');
    proc.close(1);
    const outcome = await run.done as any;
    expect(outcome).toMatchObject({ kind: 'failed', code: 'runtime.apiError' });
    expect(outcome.error).toContain('Model not found');
  });

  it('同一个 text part 重复出现只记一次；不同 part 之间分段', async () => {
    const { run, proc } = await launched();
    const text = (id: string, t: string) => ({ type: 'text', sessionID: 's', part: { id, type: 'text', text: t } });
    proc.line(text('p1', 'first'));
    proc.line(text('p1', 'first'));
    proc.line(text('p2', 'second'));
    proc.close(0);
    expect(await run.done).toMatchObject({ outputText: 'first\n\nsecond' });
  });

  it('工具状态 error → 失败的工具结果，输出取 state.error', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'tool_use', sessionID: 's', part: { type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'error', input: { path: 'a' }, error: 'file not found' } } });
    proc.line({ type: 'step_finish', sessionID: 's', part: { id: 'f1', type: 'step-finish', tokens: { input: 1, output: 1 } } });
    proc.close(0);
    await run.done;
    expect((run.canonical().find((e: any) => e.item?.type === 'function_call_output') as any).item).toMatchObject({ status: 'failed', output: 'file not found' });
  });

  it('退出码 0 却没有任何事件：runtime.noOutput', async () => {
    const { run, proc } = await launched();
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.noOutput' });
  });
});

describe('OpenCode：close、中止、续话、错误', () => {
  it('exit 先到：step_finish 在 exit 之后才读到，也算', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'step_start', sessionID: 's1', part: { id: 'a', type: 'step-start' } });
    proc.exit(0);
    await flushMicrotasks();
    proc.line({ type: 'text', sessionID: 's1', part: { id: 'b', type: 'text', text: 'late' } });
    proc.line({ type: 'step_finish', sessionID: 's1', part: { id: 'c', type: 'step-finish', tokens: { input: 2, output: 1 } } });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'late' });
    expect(run.types()).toContain('usage.reported');
  });

  it('中止：停进程组，close 后 aborted', async () => {
    const { run, proc } = await launched();
    run.abort.abort();
    expect(await run.done).toMatchObject({ kind: 'aborted', synced: true });
    expect(proc.terminateCalls).toBe(1);
  });

  it('-s 指向不存在的会话：runtime.resumeFailed', async () => {
    const h = harness();
    await firstTurn(h);
    const { run, proc } = await launched(h, baseRequest({ resume: true }));
    proc.stderr('Error: Session not found\n');
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.resumeFailed' });
  });

  it('scoped 下换了 provider：不带 -s，开新会话', async () => {
    const h = harness();
    await firstTurn(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, provider: 'moonshot' } }), 'scoped');
    expect(proc.spec.args).not.toContain('-s');
  });

  it('没安装：runtime.notInstalled；网关错误文本：runtime.apiError', async () => {
    const missing = harness();
    missing.manager.missing = true;
    expect(await startRun(createOpenCodeAdapter(missing.deps), baseRequest()).done).toMatchObject({ code: 'runtime.notInstalled' });
    const { run, proc } = await launched();
    proc.line({ type: 'text', sessionID: 's', part: { id: 't', type: 'text', text: 'Provider returned HTTP 429' } });
    proc.close(0);
    expect(await run.done).toMatchObject({ code: 'runtime.apiError' });
  });
});

describe('OpenCode：同轮双路事件仲裁', () => {
  it('scoped：代理 tee 的文本与工具都丢，只信 CLI；用量只信代理', async () => {
    const h = harness();
    const { store, realtime, submitted, runId } = await submitThroughCoordinator(createOpenCodeAdapter(h.deps), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await h.exec.next();
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'p', delta: 'ok' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc', call_id: 'call_p', name: 'bash', arguments: '{}' } });
    h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:o1', scope: 'model_call', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    proc.lines(readFixtureLines('opencode', 'real-mock-tool-turn.jsonl'));
    proc.close(0);
    await submitted.completion;
    expect(toolStartedIds(realtime)).toEqual(['call_mock2']);
    expect(deltaText(realtime)).toBe('ok');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:o1']);
  });
});
