/**
 * Codex 适配器。
 *
 * fixtures/real-*.jsonl 是本机 `codex-cli` 0.153.4 `exec --json` 的真实输出（2026-09-15，global 模式，
 * 第二轮是 `exec resume` 并调了一次 shell）。
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../../../../src/runtime/adapters/codex';
import { CODEX_SOURCE_OF_TRUTH } from '../../../../src/runtime/adapters/codex/definition';
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

const HOME = homeFor('codex');
const THREAD = '01a0a31b-d4a0-7a51-8641-4bcf77b154e3';

async function launched(h = harness(), request = baseRequest(), proxyMode?: 'global' | 'scoped') {
  const adapter = createCodexAdapter(h.deps);
  const run = startRun(adapter, request, { proxyMode });
  const proc = await h.exec.next();
  return { h, adapter, run, proc };
}

async function completeFirstTurn(h: ReturnType<typeof harness>, request = baseRequest(), mode: 'global' | 'scoped' = 'global') {
  const first = await launched(h, request, mode);
  first.proc.lines(readFixtureLines('codex', 'real-global-turn1.jsonl'));
  first.proc.close(0);
  await first.run.done;
}

describe('Codex：命令构造', () => {
  it('global 新线程：exec --json … --cd <工作区> -，prompt 走 stdin，绕过审批与沙箱', async () => {
    const { proc } = await launched();
    const args = proc.spec.args;
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.slice(-3)).toEqual(['--cd', WORKSPACE, '-']);
    expect(proc.stdin).toBe('reply with ok\n');
    expect(proc.stdinEnded).toBe(true);
  });

  it('续话：exec resume --json … <threadId> -（resume 子命令不收 --cd，工作目录走 cwd）', async () => {
    const h = harness();
    await completeFirstTurn(h);
    const { proc } = await launched(h, baseRequest({ resume: true }));
    const args = proc.spec.args;
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(args.slice(-2)).toEqual([THREAD, '-']);
    expect(args).not.toContain('--cd');
    expect(proc.spec.cwd).toBe(WORKSPACE);
  });

  it('**global 不做影子 CODEX_HOME**：不设 CODEX_HOME、不拷 auth.json（OAuth refresh_token 会被轮换）', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.codex/auth.json`, '{"tokens":{"refresh_token":"rt"}}');
    const { proc } = await launched(h);
    expect(proc.spec.env.CODEX_HOME).toBeUndefined();
    expect([...h.fs.files.keys()].some((p) => p.endsWith('auth.json') && p.startsWith(DATA_DIR))).toBe(false);
  });

  it('金样：global（指令经 -c developer_instructions、MCP 经 -c mcp_servers.<名>、模型与推理强度）', async () => {
    const h = harness({ mcpServers: [{ name: 'clawopt.api', transport: 'stdio', command: 'node', args: ['mcp.mjs', 'api'], env: { CLAWOPT_URL: 'http://127.0.0.1:3150' } }, { name: 'remote', transport: 'http', url: 'https://mcp.example/x', headers: { 'X-Team': 'a' } }] });
    const { proc } = await launched(h, baseRequest({ model: 'gpt-6', reasoningEffort: 'high', instructions: '用中文回答\n带 "引号"' }));
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('codex', 'global-launch.txt'));
  });

  it('金样：scoped（用户 config.toml 过滤后保留、自定义 provider 指向代理、令牌经 env_key）', async () => {
    const h = harness();
    h.fs.seed(`${USER_HOME}/.codex/config.toml`, [
      'model = "gpt-6-astra"',
      'model_reasoning_effort = "high"',
      'approval_policy = "never"',
      '',
      '[model_providers.old]',
      'base_url = "https://stale.example"',
      'experimental_bearer_token = "stale"',
      '',
      '[mcp_servers.user]',
      'command = "npx"',
      '',
      '[projects."/work/project"]',
      'trust_level = "trusted"',
    ].join('\n'));
    h.fs.seed(`${USER_HOME}/.codex/AGENTS.md`, '# 用户全局指令');
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: { ...SCOPED_PROVIDER, apiMode: 'responses', reasoningEffort: 'medium' }, instructions: 'ClawOPT 规则' }), 'scoped');
    await expect(renderLaunch({ files: writtenFiles(h.fs, HOME), spec: proc.spec, stdin: proc.stdin })).toMatchFileSnapshot(goldenPath('codex', 'scoped-launch.txt'));
  });

  it('**scoped：上游 key 与代理令牌都不进文件**；令牌只在 CLAWOPT_CODEX_API_KEY', async () => {
    const h = harness();
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const files = [...h.fs.files.values()].map((f) => f.content).join('\n');
    expect(files).not.toContain(SCOPED_PROVIDER.apiKey);
    expect(files).not.toContain('clawopt_proxy_token');
    expect(proc.spec.args.join(' ')).not.toContain('clawopt_proxy_token');
    expect(proc.spec.env.CLAWOPT_CODEX_API_KEY).toBe('clawopt_proxy_token_abcdefghijkl');
    expect(proc.spec.env.CODEX_HOME).toBe(path.join(HOME, 'codex-home'));
    expect(proc.spec.env.OPENAI_API_KEY, 'scoped 不该继承用户的 OpenAI key').toBeUndefined();
  });

  it('global 放行 OpenAI 凭据变量，别的挡住', async () => {
    const { proc } = await launched();
    expect(proc.spec.env.OPENAI_API_KEY).toBe('sk-user-openai-key-000000');
    expect(proc.spec.env.SECRET_TOKEN).toBeUndefined();
  });

  it('图片经 --image 传路径；压缩改起 app-server', async () => {
    const withImage = await launched(harness(), baseRequest({ images: [{ path: '/tmp/a.png', mimeType: 'image/png' }] }));
    expect(withImage.proc.spec.args[withImage.proc.spec.args.indexOf('--image') + 1]).toBe('/tmp/a.png');
    const compact = await launched(harness(), baseRequest({ command: { kind: 'compact' } }));
    expect(compact.proc.spec.args[0]).toBe('app-server');
    expect(compact.proc.spec.stdin).toBe('pipe');
  });
});

describe('Codex：解析真实 JSONL', () => {
  it('首轮：线程 id 成为原生会话、正文 ok、用量（输入不含缓存部分）', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('codex', 'real-global-turn1.jsonl'));
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'ok' });
    const events = run.canonical();
    expect(events.find((e) => e.type === 'runtime.native_session')).toMatchObject({ nativeSessionId: THREAD });
    const usage = (events.find((e) => e.type === 'usage.reported') as any).usage;
    expect(usage).toMatchObject({ callId: `codex:${THREAD}:run_1:0`, inputTokens: 18297 - 12928, cacheReadTokens: 12928, outputTokens: 5 });
  });

  it('工具轮：command_execution 只出一张卡、输出进 function_call_output；工具前后的正文分成两段', async () => {
    const { run, proc } = await launched();
    proc.lines(readFixtureLines('codex', 'real-global-resume-tool-turn2.jsonl'));
    proc.close(0);
    const outcome = await run.done as any;
    expect(outcome.outputText).toBe('I’ll run the command now.\n\nok');
    const events = run.canonical() as any[];
    const calls = events.filter((e) => e.type === 'response.output_item.added' && e.item.type === 'function_call');
    expect(calls).toHaveLength(1);
    expect(calls[0].item).toMatchObject({ call_id: 'item_1', name: 'Command' });
    expect(JSON.parse(calls[0].item.arguments)).toEqual({ command: "/bin/zsh -lc 'echo hi'" });
    const output = events.find((e) => e.item?.type === 'function_call_output');
    expect(output.item).toMatchObject({ output: 'hi\n', status: 'completed' });
  });

  it('名为 exec_command 的 mcp_tool_call 是 command_execution 的回声，丢掉', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
    proc.line({ type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'codex', tool: 'exec_command', arguments: {} } });
    proc.line({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'codex', tool: 'exec_command', result: 'x' } });
    proc.line({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } });
    proc.line({ type: 'turn.completed', usage: {} });
    proc.close(0);
    await run.done;
    expect(run.canonical().filter((e: any) => e.type === 'response.output_item.added' && e.item.type === 'function_call').map((e: any) => e.item.call_id)).toEqual(['i1']);
  });

  it('非零退出码的命令记为失败的工具结果', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'completed' } });
    proc.line({ type: 'turn.completed', usage: {} });
    proc.close(0);
    await run.done;
    expect((run.canonical().find((e: any) => e.item?.type === 'function_call_output') as any).item.status).toBe('failed');
  });
});

describe('Codex：错误映射', () => {
  it('`error` 是临时的：退出码 0 时不算失败', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'error', message: 'stream disconnected, retrying 1/5' });
    proc.line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'ok' } });
    proc.line({ type: 'turn.completed', usage: {} });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed' });
  });

  it('turn.failed：即使退出码 0 也判失败（runtime.apiError）', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'turn.failed', error: { message: 'model overloaded' } });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.apiError', error: 'model overloaded' });
  });

  it('非零退出 + 401：runtime.notLoggedIn；详情优先用协议里的错误而不是 stderr', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'error', message: 'unexpected status 401 Unauthorized' });
    proc.stderr('some noisy stderr\n');
    proc.close(1);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.notLoggedIn', error: 'unexpected status 401 Unauthorized' });
  });

  it('终文是网关错误文本：判 runtime.apiError', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Provider returned HTTP 502' } });
    proc.line({ type: 'turn.completed', usage: {} });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.apiError' });
  });

  it('没安装：runtime.notInstalled', async () => {
    const h = harness();
    h.manager.missing = true;
    expect(await startRun(createCodexAdapter(h.deps), baseRequest()).done).toMatchObject({ code: 'runtime.notInstalled' });
  });
});

describe('Codex：续话兼容性', () => {
  it('scoped 下换了 apiMode：不续旧线程', async () => {
    const h = harness();
    await completeFirstTurn(h, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const { proc } = await launched(h, baseRequest({ mode: 'scoped', resume: true, provider: { ...SCOPED_PROVIDER, apiMode: 'responses' } }), 'scoped');
    expect(proc.spec.args.slice(0, 2)).toEqual(['exec', '--json']);
  });

  it('表面换了会话句柄（上一轮失败后重开）：不续旧线程', async () => {
    const h = harness();
    await completeFirstTurn(h);
    const { proc } = await launched(h, baseRequest({ resume: true, sessionId: '22222222-2222-4222-8222-222222222222' }));
    expect(proc.spec.args).not.toContain('resume');
  });

  it('首轮没观察到线程 id：下一轮不续（不拿句柄去猜）', async () => {
    const h = harness();
    const first = await launched(h);
    first.proc.close(1);
    await first.run.done;
    const { proc } = await launched(h, baseRequest({ resume: true }));
    expect(proc.spec.args).not.toContain('resume');
  });
});

describe('Codex：close 与中止', () => {
  it('exit 先到：turn.completed 在 exit 之后才读到，也要算进这一轮', async () => {
    const { run, proc } = await launched();
    proc.line({ type: 'thread.started', thread_id: 't1' });
    proc.exit(0);
    await flushMicrotasks();
    proc.line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'late text' } });
    proc.line({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } });
    proc.close(0);
    expect(await run.done).toMatchObject({ kind: 'completed', outputText: 'late text' });
    expect(run.types()).toContain('usage.reported');
  });

  it('中止：停进程组，close 后 aborted', async () => {
    const { run, proc } = await launched();
    run.abort.abort();
    await flushMicrotasks();
    expect(proc.terminateCalls).toBe(1);
    expect(await run.done).toMatchObject({ kind: 'aborted', synced: true });
  });
});

describe('Codex：app-server 压缩', () => {
  it('initialize → initialized → thread/resume → thread/compact/start → thread/compacted', async () => {
    const sent: any[] = [];
    const h = harness({
      executorOptions: {
        onLaunch: (proc) => {
          if (proc.spec.args[0] !== 'app-server') return;
          proc.onWrite((data) => {
            for (const line of data.split('\n').filter(Boolean)) {
              const message = JSON.parse(line);
              sent.push(message);
              if (message.method === 'initialize') setImmediate(() => proc.line({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'codex' } }));
              if (message.method === 'thread/resume') {
                setImmediate(() => {
                  proc.line({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: THREAD, tokenUsage: { last: { totalTokens: 50000 } } } });
                  proc.line({ jsonrpc: '2.0', id: message.id, result: { thread: { id: THREAD } } });
                });
              }
              if (message.method === 'thread/compact/start') {
                setImmediate(() => {
                  proc.line({ jsonrpc: '2.0', id: message.id, result: {} });
                  proc.line({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: THREAD, tokenUsage: { last: { totalTokens: 9000 } } } });
                  proc.line({ jsonrpc: '2.0', method: 'thread/compacted', params: { threadId: THREAD } });
                });
              }
            }
          });
        },
      },
    });
    await completeFirstTurn(h);
    const { run, proc } = await launched(h, baseRequest({ resume: true, command: { kind: 'compact' } }));
    await flushMicrotasks(20);
    expect(proc.terminateCalls).toBeGreaterThan(0);
    const outcome = await run.done;
    expect(sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/compact/start']);
    expect(sent[2].params).toEqual({ threadId: THREAD });
    expect(outcome).toMatchObject({ kind: 'completed', stopReason: 'compacted' });
    expect(run.canonical().find((e) => e.type === 'plan.updated')).toMatchObject({ plan: { kind: 'compact_boundary', preTokens: 50000, postTokens: 9000 } });
  });

  it('没有确认过的线程：runtime.resumeFailed，不发任何请求', async () => {
    const { run, proc } = await launched(harness(), baseRequest({ command: { kind: 'compact' } }));
    expect(await run.done).toMatchObject({ kind: 'failed', code: 'runtime.resumeFailed' });
    expect(proc.stdin).toBe('');
  });
});

describe('Codex：同轮双路事件仲裁', () => {
  it('scoped：代理增量先流出、CLI 整条消息去重；工具卡只信 CLI；用量只信代理', async () => {
    const h = harness();
    const adapter = createCodexAdapter(h.deps);
    const { store, realtime, submitted, runId } = await submitThroughCoordinator(adapter, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await h.exec.next();
    proc.line({ type: 'thread.started', thread_id: 't1' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'message', id: 'msg_p1', role: 'assistant' } });
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'Let me check ' });
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'the file first.' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{}' } });
    h.proxy.push(runId, { type: 'usage.reported', usage: { callId: 'proxy:resp_1', scope: 'model_call', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, apiCalls: 1 } });
    proc.line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Let me check the file first.' } });
    proc.line({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat a', status: 'in_progress' } });
    proc.line({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'cat a', aggregated_output: 'A', exit_code: 0, status: 'completed' } });
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'msg_p2', delta: 'ok' });
    proc.line({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'ok' } });
    proc.line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    proc.close(0);
    await submitted.completion;
    expect(toolStartedIds(realtime)).toEqual(['item_1']);
    expect(deltaText(realtime), '短文本（<16 字符）被两路拼了两遍').toBe('Let me check the file first.\n\nok');
    expect(store.usage.map((u) => u.callId)).toEqual(['proxy:resp_1']);
  });

  it('两路文本交给协调器（表里 text: [proxy, native]，驱动不再自己折叠）：只有一句 ok 时不拼成 okok', async () => {
    expect(CODEX_SOURCE_OF_TRUTH.text).toEqual(['proxy', 'native']);
    const h = harness();
    const adapter = createCodexAdapter(h.deps);
    const { realtime, submitted, runId } = await submitThroughCoordinator(adapter, baseRequest({ mode: 'scoped', provider: SCOPED_PROVIDER }), 'scoped');
    const proc = await h.exec.next();
    proc.line({ type: 'thread.started', thread_id: 't1' });
    h.proxy.push(runId, { type: 'response.output_item.added', item: { type: 'message', id: 'msg_p1', role: 'assistant' } });
    h.proxy.push(runId, { type: 'response.output_text.delta', item_id: 'msg_p1', delta: 'ok' });
    proc.line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } });
    proc.line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } });
    proc.close(0);
    await submitted.completion;
    expect(deltaText(realtime)).toBe('ok');
  });
});
