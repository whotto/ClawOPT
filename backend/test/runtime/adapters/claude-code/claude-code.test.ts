/**
 * Claude Code 适配器（契约版）。
 *
 * fixtures/real-*.jsonl 是本机 `claude` 2.1.272 的真实 stream-json（2026-09-15，global 模式，haiku），
 * 只脱敏了路径、思维签名与本机的 skills / plugins 清单。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createClaudeCodeAdapter } from '../../../../src/runtime/adapters/claude-code';
import { SESSION_STATE_FILE } from '../../../../src/runtime/adapters/_shared/session-state';
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
import { deltaText, submitThroughCoordinator, toolStartedIds } from '../_helpers/coordinator';

const HOME = homeFor('claude-code');

function resultLine(over: Record<string, unknown> = {}) {
  return { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-1', uuid: 'res-1', total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2 }, ...over };
}

async function launched(h = harness(), request = baseRequest(), proxyMode?: 'global' | 'scoped') {
  const adapter = createClaudeCodeAdapter(h.deps);
  const run = startRun(adapter, request, { proxyMode });
  const proc = await h.exec.next();
  return { h, adapter, run, proc };
}

describe('Claude Code：命令构造（global）', () => {
  it('基础参数：-p + stream-json + --verbose + partial + 拒绝弹窗；prompt 走 stdin 不进 argv', async () => {
    const { proc } = await launched();
    const args = proc.spec.args;
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(args[args.indexOf('--input-format') + 1]).toBe('text');
    expect(args).not.toContain('reply with ok');
    expect(proc.stdin).toBe('reply with ok\n');
    expect(proc.stdinEnded, '写完 stdin 不关，CLI 会一直等输入').toBe(true);
    expect(proc.spec.cwd).toBe(WORKSPACE);
  });

  it('**两种模式都从不出现绕过权限的开关**', async () => {
    for (const mode of ['global', 'scoped'] as const) {
      const request = baseRequest({ mode, provider: mode === 'scoped' ? SCOPED_PROVIDER : undefined });
      const { proc } = await launched(harness(), request, mode);
      const joined = proc.spec.args.join(' ');
      expect(joined).not.toContain('dangerously-skip-permissions');
      expect(joined).not.toContain('bypassPermissions');
    }
  });

  it('首轮 --session-id 用表面预生成的句柄，不带 --resume；预生成 id 先记进 home（未确认）', async () => {
    const { h, proc } = await launched();
    expect(proc.spec.args[proc.spec.args.indexOf('--session-id') + 1]).toBe('11111111-1111-4111-8111-111111111111');
    expect(proc.spec.args).not.toContain('--resume');
    const state = JSON.parse(h.fs.readText(path.join(HOME, SESSION_STATE_FILE))!);
    expect(state).toMatchObject({ nativeSessionId: '11111111-1111-4111-8111-111111111111', confirmed: false });
  });

  it('超长中文 prompt（>96 KiB）照样走 stdin，argv 里没有它', async () => {
    const long = '长'.repeat(80_000);
    const { proc } = await launched(harness(), baseRequest({ prompt: long }));
    expect(proc.spec.args.some((arg) => arg.includes('长长长'))).toBe(false);
    expect(proc.stdin.length).toBe(long.length + 1);
  });

  it('群聊系统提示替换基础提示，经 --append-system-prompt-file 传入托管块', async () => {
    const { h, proc } = await launched(harness(), baseRequest({ systemPrompt: '基础提示', groupSystemPrompt: '群设定', instructions: '成员追加' }));
    const file = proc.spec.args[proc.spec.args.indexOf('--append-system-prompt-file') + 1];
    const content = h.fs.readText(file)!;
    expect(content).toContain('群设定');
    expect(content).toContain('成员追加');
    expect(content).not.toContain('基础提示');
    expect(content).toContain('<!-- BEGIN CLAWOPT PROMPT -->');
  });

  it('金样：global 启动（模型覆盖、MCP、指令、白名单与护栏）', async () => {
    const h = harness({ mcpServers: [{ name: 'clawopt-api', transport: 'stdio', command: 'node', args: ['mcp.mjs', 'api'], env: { CLAWOPT_URL: 'http://127.0.0.1:3150' } }] });
    const { proc } = await launched(h, baseRequest({ model: 'haiku', instructions: '用中文回答', allowedTools: ['Read'], maxBudgetUsd: 0.5, extraDirs: ['/work/shared'] }));
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('claude-code', 'global-launch.txt'));
  });
});

describe('Claude Code：命令构造（scoped）', () => {
  const inheritedSettings = JSON.stringify({
    apiKeyHelper: '/usr/local/bin/get-key',
    forceLoginMethod: 'claudeai',
    permissions: { allow: ['Bash(git status)'] },
    env: { ANTHROPIC_BASE_URL: 'https://stale.example', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-stale', CLAUDE_CODE_USE_BEDROCK: '1', KEEP_ME: 'yes' },
  });

  it('金样：scoped 启动（继承设置被清洗、模型别名全部指向选定模型、代理地址）', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.claude/settings.json`, inheritedSettings);
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('claude-code', 'scoped-launch.txt'));
  });

  it('**上游 key 不进任何文件与参数**；代理令牌也只在进程环境里', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.claude/settings.json`, inheritedSettings);
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const everything = [...h.fs.files.values()].map((f) => f.content).join('\n') + proc.spec.args.join(' ');
    expect(everything).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(everything).not.toContain('clawopt_proxy_token');
    expect(proc.spec.env.ANTHROPIC_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');
    expect(h.proxy.registered[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4', runtime: 'claude-code', apiKey: SCOPED_PROVIDER.apiKey });
  });

  it('继承的认证项被剥掉：apiKeyHelper、forceLoginMethod、ANTHROPIC_*、OAuth token、Bedrock 开关', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.claude/settings.json`, inheritedSettings);
    await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const settings = JSON.parse(h.fs.readText(path.join(HOME, 'settings.json'))!);
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.forceLoginMethod).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(settings.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(settings.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3150/api/claude-code-proxy/route_1');
    expect(settings.env.KEEP_ME).toBe('yes');
    expect(settings.permissions).toEqual({ allow: ['Bash(git status)'] });
  });

  it('子进程环境：scoped 只有白名单 + 启动变量；global 额外放行 Anthropic 凭据变量', async () => {
    const processEnv = { PATH: '/usr/bin', HOME: USER_HOME, SECRET_TOKEN: 'leak-me', ANTHROPIC_API_KEY: 'sk-ant-user-key-000000', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-user' };
    const scoped = await launched(harness({ processEnv }), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    expect(scoped.proc.spec.env.SECRET_TOKEN).toBeUndefined();
    expect(scoped.proc.spec.env.CLAUDE_CODE_OAUTH_TOKEN, '残留 OAuth 会盖过代理').toBeUndefined();
    expect(scoped.proc.spec.env.ANTHROPIC_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');

    const global = await launched(harness({ processEnv }), baseRequest());
    expect(global.proc.spec.env.SECRET_TOKEN).toBeUndefined();
    expect(global.proc.spec.env.ANTHROPIC_API_KEY).toBe('sk-ant-user-key-000000');
  });

  it('**守卫证明会红**：管理器把整份环境合并进来，适配器仍然只留白名单', async () => {
    const h = harness();
    h.manager.leakyEnv = { SECRET_TOKEN: 'leak-me', AWS_SECRET_ACCESS_KEY: 'aws' };
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    expect(Object.keys(proc.spec.env).sort()).toEqual([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_MODEL_OPTION', 'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'ANTHROPIC_MODEL', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'ENABLE_TOOL_SEARCH', 'HOME', 'LANG', 'PATH',
    ]);
  });

  it('带图片时改用 stream-json 输入，jpg 规范成 image/jpeg', async () => {
    const { proc } = await launched(harness(), baseRequest({ images: [{ path: '/tmp/a.jpg', mimeType: 'image/jpg', data: 'AAAA' }] }));
    expect(proc.spec.args[proc.spec.args.indexOf('--input-format') + 1]).toBe('stream-json');
    const message = JSON.parse(proc.stdin);
    expect(message.message.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  });

  it('/compact 作为一轮普通输入发出；status 不支持且不起进程', async () => {
    const compact = await launched(harness(), baseRequest({ command: { kind: 'compact', instructions: '保留结论' } }));
    expect(compact.proc.stdin).toBe('/compact 保留结论\n');

    const h = harness();
    const run = startRun(createClaudeCodeAdapter(h.deps), baseRequest({ command: { kind: 'status' } }));
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.commandUnsupported' });
    expect(h.exec.processes).toHaveLength(0);
  });

  it('system/compact_boundary（手动 /compact 或运行中途自动）→ 契约事件 session.command，不走 plan.updated', async () => {
    const { run, proc } = await launched(harness(), baseRequest({ command: { kind: 'compact' } }));
    proc.line({ type: 'system', subtype: 'compact_boundary', session_id: '11111111-1111-4111-8111-111111111111', compact_metadata: { trigger: 'manual', pre_tokens: 48210 } });
    proc.line({ type: 'system', subtype: 'compact_boundary', session_id: '11111111-1111-4111-8111-111111111111', compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 21000 } });
    proc.line({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: '11111111-1111-4111-8111-111111111111', uuid: 'r-compact' });
    proc.close(0);
    await run.done;
    expect(run.canonical().filter((e) => e.type === 'session.command').map((e: any) => e.result)).toEqual([
      { command: 'compact', ok: true, compaction: { trigger: 'manual', preTokens: 48210, postTokens: undefined } },
      { command: 'compact', ok: true, compaction: { trigger: 'auto', preTokens: 150000, postTokens: 21000 } },
    ]);
    expect(run.canonical().some((e) => e.type === 'plan.updated')).toBe(false);
  });
});

describe('Claude Code：解析真实 stream-json', () => {
  it('首轮：正文 ok、原生会话 id、整轮用量带成本、completed 在 close 之后', async () => {
    const { run, proc, h } = await launched();
    proc.lines(readFixtureLines('claude-code', 'real-global-turn1.jsonl'));
    await flushMicrotasks();
    expect(run.types()).not.toContain('response.completed');
    proc.close(0);
    const outcome = await run.done;
    expect(outcome).toMatchObject({ kind: 'completed', outputText: 'ok' });
    const events = run.canonical();
    expect(events.filter((e) => e.type === 'response.output_text.delta').map((e: any) => e.delta).join('')).toBe('ok');
    const usage = events.filter((e) => e.type === 'usage.reported').map((e: any) => e.usage);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ callId: 'claude-code:76f9ae81-65f2-4955-b0d4-26b73d2ff33d:635620b1-9157-4338-bd8d-389d03ec26bd', model: 'claude-haiku-4-5-20251001', inputTokens: 9, cacheReadTokens: 13607, cacheWriteTokens: 8242 });
    expect(usage[0].costUsd).toBeCloseTo(0.0191187, 7);
    expect(events.find((e) => e.type === 'runtime.init')).toMatchObject({ runtimeVersion: '2.1.272' });
    expect(events.at(-1)?.type).toBe('response.completed');
    // 原生 id 被确认，下一轮就能续
    const state = JSON.parse(h.fs.readText(path.join(HOME, SESSION_STATE_FILE))!);
    expect(state).toMatchObject({ nativeSessionId: '76f9ae81-65f2-4955-b0d4-26b73d2ff33d', confirmed: true });
  });

  it('工具轮：stream 与整条 assistant 各报一次 tool_use，只出一张工具卡；结果进 function_call_output', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('claude-code', 'real-global-tool-turn3.jsonl'));
    proc.close(0);
    await run.done;
    const events = run.canonical();
    const added = events.filter((e: any) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    const done = events.filter((e: any) => e.type === 'response.output_item.done' && e.item.type === 'function_call');
    expect(added).toHaveLength(1);
    expect(done).toHaveLength(1);
    expect((done[0] as any).item).toMatchObject({ name: 'Read', call_id: 'toolu_0188wt28tzkuta8vzjz6tNrf' });
    expect(JSON.parse((done[0] as any).item.arguments).file_path).toBe('/workspace/ws/note.txt');
    const output = events.find((e: any) => e.type === 'response.output_item.done' && e.item.type === 'function_call_output') as any;
    expect(output.item).toMatchObject({ call_id: 'toolu_0188wt28tzkuta8vzjz6tNrf', status: 'completed' });
    expect(output.item.output).toContain('hello from file');
  });

  it('hook_response 里的 stdout 不当正文', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'system', subtype: 'hook_response', stdout: '/home/user/.secret', output: 'x', session_id: 's' });
    proc.line(resultLine({ result: '' }));
    proc.close(0);
    await run.done;
    expect(run.canonical().some((e: any) => JSON.stringify(e).includes('.secret'))).toBe(false);
  });

  it('多模型用量按模型拆行，callId 确定', async () => {
    const { run, proc } = await launched();
    proc.line(resultLine({ modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 3, costUSD: 0.1 }, 'claude-haiku-4-5': { inputTokens: 2, outputTokens: 1, costUSD: 0.001 } } }));
    proc.close(0);
    await run.done;
    const ids = run.canonical().filter((e) => e.type === 'usage.reported').map((e: any) => e.usage.callId);
    expect(ids).toEqual(['claude-code:sess-1:res-1:claude-opus-5', 'claude-code:sess-1:res-1:claude-haiku-4-5']);
  });

  it('没有流式增量的老输出：整块 assistant 文本补成正文', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: '你好世界' }] } });
    proc.line(resultLine({ result: '你好世界' }));
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: '你好世界' });
  });
});

describe('Claude Code：close 与 exit 的顺序', () => {
  it('exit 先到、result 后到：以 close 为准，不提前判完成', async () => {
    const { run, proc } = await launched();
    proc.exit(0);
    await flushMicrotasks();
    let settled = false;
    void run.done.then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled, 'exit 就判了完成，最后一行会丢').toBe(false);
    proc.line({ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.apiError', error: 'API Error: 529 overloaded' });
  });

  it('退出码 0 但没有任何输出：runtime.noOutput', async () => {
    const { run, proc } = await launched();
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.noOutput' });
  });
});

describe('Claude Code：续话兼容性', () => {
  async function secondTurn(h: ReturnType<typeof harness>, request: ReturnType<typeof baseRequest>, mode: 'global' | 'scoped' = 'global') {
    const adapter = createClaudeCodeAdapter(h.deps);
    const run = startRun(adapter, request, { proxyMode: mode });
    const proc = await h.exec.next();
    return { run, proc };
  }

  it('确认过的会话下一轮 --resume 原生 id', async () => {
    const h = harness();
    const first = await secondTurn(h, baseRequest());
    first.proc.line({ type: 'system', subtype: 'init', session_id: '11111111-1111-4111-8111-111111111111' });
    first.proc.line(resultLine({ session_id: '11111111-1111-4111-8111-111111111111' }));
    first.proc.close(0);
    await first.run.done;
    const second = await secondTurn(h, baseRequest({ resume: true }));
    expect(second.proc.spec.args[second.proc.spec.args.indexOf('--resume') + 1]).toBe('11111111-1111-4111-8111-111111111111');
    expect(second.proc.spec.args).not.toContain('--session-id');
  });

  it('scoped 下换了模型：不续旧会话，另起一个新的原生 id', async () => {
    const h = harness();
    const first = await secondTurn(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    first.proc.line(resultLine({ session_id: '11111111-1111-4111-8111-111111111111' }));
    first.proc.close(0);
    await first.run.done;
    const second = await secondTurn(h, baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, model: 'deepseek-v5' } }), 'scoped');
    expect(second.proc.spec.args).not.toContain('--resume');
    const created = second.proc.spec.args[second.proc.spec.args.indexOf('--session-id') + 1];
    expect(created).not.toBe('11111111-1111-4111-8111-111111111111');
  });

  it('首轮没被 CLI 确认（中途崩了）：下一轮仍用同一个预生成 id 新建，而不是 resume 一个不存在的会话', async () => {
    const h = harness();
    const first = await secondTurn(h, baseRequest());
    first.proc.close(1);
    await first.run.done;
    const second = await secondTurn(h, baseRequest({ resume: true }));
    expect(second.proc.spec.args).not.toContain('--resume');
    expect(second.proc.spec.args[second.proc.spec.args.indexOf('--session-id') + 1]).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('迁移前的群成员（home 里没有状态、表面说能续）：照旧 --resume 句柄', async () => {
    const h = harness();
    const run = await secondTurn(h, baseRequest({ resume: true }));
    expect(run.proc.spec.args[run.proc.spec.args.indexOf('--resume') + 1]).toBe('11111111-1111-4111-8111-111111111111');
  });
});

describe('Claude Code：中止', () => {
  it('中止：先停进程组，等 close 才确认已停', async () => {
    const { run, proc } = await launched(harness({ executorOptions: { closeOnTerminate: false } }));
    const interrupted = run.handle.interrupt('user_stop');
    run.abort.abort();
    await flushMicrotasks();
    expect(proc.terminateCalls).toBeGreaterThan(0);
    let settled = false;
    void run.done.then(() => { settled = true; });
    await flushMicrotasks();
    expect(settled, '没等 close 就当已停').toBe(false);
    proc.close(null, 'SIGINT');
    expect(await run.done).toMatchObject({ kind: 'aborted', reason: 'user_stop', synced: true, phase: 'running' });
    expect(await interrupted).toEqual({ synced: true });
  });

  it('准备阶段就被中止：不起进程', async () => {
    const h = harness();
    const run = startRun(createClaudeCodeAdapter(h.deps), baseRequest());
    run.abort.abort();
    expect(await run.done).toMatchObject({ kind: 'aborted', phase: 'preparing' });
    expect(h.exec.processes).toHaveLength(0);
    expect(h.manager.runsEnded).toBe(h.manager.runsBegun);
  });
});

describe('Claude Code：错误映射', () => {
  it('没安装：runtime.notInstalled，不起进程', async () => {
    const h = harness();
    h.manager.missing = true;
    const run = startRun(createClaudeCodeAdapter(h.deps), baseRequest());
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.notInstalled' });
    expect(h.exec.processes).toHaveLength(0);
  });

  it('spawn ENOENT（PATH 在探测后变了）：runtime.notInstalled', async () => {
    const { run, proc } = await launched();
    proc.spawnError('ENOENT', 'spawn claude ENOENT');
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.notInstalled' });
  });

  it('续话指向不存在的会话：runtime.resumeFailed', async () => {
    const { run, proc } = await launched(harness(), baseRequest({ resume: true }));
    proc.stderr('No conversation found with session ID: 11111111-1111-4111-8111-111111111111\n');
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.resumeFailed' });
  });

  it('result 报错（没登录）：runtime.notLoggedIn，即使 subtype 看着正常', async () => {
    const { run, proc } = await launched();
    proc.line(resultLine({ is_error: true, result: 'Not logged in · Please run /login' }));
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn' });
  });

  it('非零退出：runtime.exitNonZero，详情是脱敏后的 stderr 尾巴', async () => {
    const { run, proc } = await launched();
    proc.stderr(`boom at ${USER_HOME}/secret with Bearer abcdefghijklmnop\n`);
    proc.close(2);
    const outcome = await run.done as any;
    expect(outcome).toMatchObject({ kind: 'failed', code: 'runtime.exitNonZero' });
  });

  it('正在升级：runtime.updating；scoped 缺凭据 / OAuth 服务商 / 缺模型各自有码', async () => {
    const updating = harness();
    updating.manager.updating = true;
    expect(await startRun(createClaudeCodeAdapter(updating.deps), baseRequest()).done).toMatchObject({ code: 'runtime.updating' });

    const h = harness();
    const adapter = createClaudeCodeAdapter(h.deps);
    expect(await startRun(adapter, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, apiKey: '' } }), { proxyMode: 'scoped' }).done).toMatchObject({ code: 'runtime.providerCredentialsMissing' });
    expect(await startRun(adapter, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, provider: 'claude-oauth' } }), { proxyMode: 'scoped' }).done).toMatchObject({ code: 'runtime.oauthProviderScopedUnsupported' });
    expect(await startRun(adapter, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, model: '' } }), { proxyMode: 'scoped' }).done).toMatchObject({ code: 'runtime.modelRequired' });
    expect(h.exec.processes).toHaveLength(0);
  });

  it('收尾撤销代理目标、释放运行计数', async () => {
    const { run, proc, h } = await launched(harness(), baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    proc.line(resultLine());
    proc.close(0);
    await run.done;
    expect(h.proxy.revoked).toBe(1);
    expect(h.manager.runsEnded).toBe(1);
  });
});

describe('Claude Code：同轮双路事件仲裁（经协调器）', () => {
  it('scoped：CLI 与代理 tee 都报了同一次工具调用 → 只有一张工具卡、文本一遍、用量只信代理', async () => {
    const h = harness();
    const adapter = createClaudeCodeAdapter(h.deps);
    const { store, realtime, submitted, runId } = await submitThroughCoordinator(adapter, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await h.exec.next();
    // 代理 tee（id 不同）
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'msg_p', delta: 'Let me read it.' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{}' } });
    h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:req_1', scope: 'model_call', inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    // CLI
    proc.line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', model: 'deepseek-v4' } }, session_id: 's1' });
    proc.line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read it.' } }, session_id: 's1' });
    proc.line({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read' } }, session_id: 's1' });
    proc.line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }] }, session_id: 's1' });
    proc.line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' }] }, session_id: 's1' });
    proc.line(resultLine({ session_id: 's1', result: 'Let me read it.' }));
    proc.close(0);
    await submitted.completion;
    expect(toolStartedIds(realtime)).toEqual(['toolu_1']);
    expect(store.toolCallBatches.flat().map((c) => c.callId)).toEqual(['toolu_1']);
    expect(deltaText(realtime)).toBe('Let me read it.');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:req_1']);
  });
});
