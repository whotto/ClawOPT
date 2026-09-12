/**
 * 本机执行器：把构造好的命令真跑起来，把 ndjson 流变成事件。
 *
 * 用**真进程**测，不是 mock 掉 spawn。理由和 `deploy-migration-gate.test.ts`
 * 一样：mock 出来的子进程不会分块、不会在行中间断开、不会因为信号死掉，
 * 而这三件恰好是执行器唯一容易写错的地方。
 *
 * 假 `claude` 是一个 shell 脚本，按用例需要吐不同的东西。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runExternalAgent } from '../src/external-agents/executor';
import { ClaudeCodeAdapter } from '../src/external-agents/claude-code';
import type { BuiltCommand, ExternalRunEvent } from '../src/external-agents/types';

const adapter = new ClaudeCodeAdapter();
let sandbox: string;

/** 造一个假 claude：body 是 shell 片段，负责往 stdout/stderr 写东西。 */
function fakeClaude(body: string): BuiltCommand {
  const script = path.join(sandbox, 'fake-claude.sh');
  fs.writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return { command: script, args: [], cwd: sandbox, stdin: 'devnull' };
}

const collect = () => {
  const events: ExternalRunEvent[] = [];
  return { events, onEvent: (e: ExternalRunEvent) => events.push(e) };
};

beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-exec-')); });
afterEach(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); }
  catch (err) { console.warn('[test] 清理沙箱失败：', err); }
});

describe('正常一轮', () => {
  it('把 ndjson 流变成 delta 与 final，并给出最终文本与成本', async () => {
    const cmd = fakeClaude(`
echo '{"type":"system","subtype":"init","model":"claude-sonnet-5","claude_code_version":"2.1.269"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"世界"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"你好世界","session_id":"sid-1","total_cost_usd":0.0067}'
`);
    const sink = collect();
    const result = await runExternalAgent(cmd, adapter, { onEvent: sink.onEvent });

    expect(result.ok).toBe(true);
    expect(result.finalText).toBe('你好世界');
    expect(result.costUsd).toBeCloseTo(0.0067, 6);
    expect(result.sessionId).toBe('sid-1');
    expect(sink.events.map((e) => e.kind)).toEqual(['init', 'delta', 'delta', 'final']);
  });

  it('**一行被拆成多个数据块时仍然正确解析**', async () => {
    // 这是执行器最容易写错的地方：stdout 的分块和行边界毫无关系。
    // 不做跨块缓冲的话，一条长回复会被切成两截 JSON，两截都解析失败。
    const cmd = fakeClaude(`
printf '{"type":"assistant","message":{"content":[{"type":"text","te'
sleep 0.15
printf 'xt":"被切成两半的内容"}]}}\\n'
echo '{"type":"result","subtype":"success","is_error":false,"result":"被切成两半的内容"}'
`);
    const sink = collect();
    const result = await runExternalAgent(cmd, adapter, { onEvent: sink.onEvent });

    expect(result.ok, '跨块的那一行没拼回来').toBe(true);
    expect(sink.events.filter((e) => e.kind === 'delta').map((e) => e.text)).toEqual(['被切成两半的内容']);
  });

  it('结尾没有换行的最后一行也要处理', async () => {
    const cmd = fakeClaude(`printf '{"type":"result","subtype":"success","is_error":false,"result":"没换行"}'`);
    const result = await runExternalAgent(fakeClaude(`printf '{"type":"result","subtype":"success","is_error":false,"result":"没换行"}'`), adapter, { onEvent: () => {} });
    expect(result.finalText).toBe('没换行');
    void cmd;
  });

  it('未知事件不打断本轮', async () => {
    const cmd = fakeClaude(`
echo '{"type":"system","subtype":"hook_started","hook_name":"x"}'
echo '{"type":"rate_limit_event"}'
echo '不是 JSON 的一行'
echo '{"type":"result","subtype":"success","is_error":false,"result":"稳住了"}'
`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });
    expect(result.ok).toBe(true);
    expect(result.finalText).toBe('稳住了');
  });
});

describe('失败路径', () => {
  it('非 0 退出且没给出 final 时判为失败', async () => {
    const cmd = fakeClaude(`echo "boom" >&2\nexit 3`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('**stderr 原文不进结果**——它可能带绝对路径甚至凭据', async () => {
    const cmd = fakeClaude(`echo "读取 /Users/someone/.openclaw/openclaw.json 失败 sk-live-abcdefghijklmnop" >&2\nexit 1`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-live-abcdefghijklmnop');
    expect(serialized).not.toContain('/Users/someone');
  });

  it('result 事件报错时如实判为失败，即使退出码是 0', async () => {
    const cmd = fakeClaude(`
echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"炸了"}'
exit 0
`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });
    expect(result.ok, '退出码 0 掩盖了事件里的失败').toBe(false);
  });

  it('命令根本不存在时返回失败而不是抛出', async () => {
    const cmd: BuiltCommand = {
      command: path.join(sandbox, '并不存在的命令'), args: [], cwd: sandbox, stdin: 'devnull',
    };
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });
    expect(result.ok).toBe(false);
    expect(result.errorDetail).toBeTruthy();
  });
});

describe('中断与超时', () => {
  it('abort 能真的把进程停掉，并标记为中断', async () => {
    const cmd = fakeClaude(`
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"开始"}]}}'
sleep 30
`);
    const controller = new AbortController();
    const promise = runExternalAgent(cmd, adapter, { onEvent: () => {}, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    controller.abort();

    const result = await promise;
    expect(result.aborted, '群里的 /stop 必须真的停得住').toBe(true);
    expect(result.ok).toBe(false);
  }, 15000);

  it('超时会结束进程并标记超时', async () => {
    const cmd = fakeClaude(`sleep 30`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {}, timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
  }, 15000);

  it('正常结束时不会被超时误伤', async () => {
    const cmd = fakeClaude(`echo '{"type":"result","subtype":"success","is_error":false,"result":"快"}'`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {}, timeoutMs: 5000 });
    expect(result.timedOut).toBeFalsy();
    expect(result.ok).toBe(true);
  });
});

describe('进程环境', () => {
  it('stdin 是 /dev/null —— 不重定向每次白等 3 秒', async () => {
    // 假 claude 去读 stdin：若 stdin 被关掉/指向 /dev/null，read 立刻返回。
    const cmd = fakeClaude(`
if read -r -t 2 line; then echo '{"type":"result","subtype":"success","result":"读到了 stdin"}'
else echo '{"type":"result","subtype":"success","is_error":false,"result":"stdin 是空的"}'; fi
`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });
    expect(result.finalText).toBe('stdin 是空的');
  }, 15000);

  it('在指定的工作目录里运行', async () => {
    const cmd = fakeClaude(`echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"$(pwd)\\"}"`);
    const result = await runExternalAgent(cmd, adapter, { onEvent: () => {} });
    expect(fs.realpathSync(String(result.finalText))).toBe(fs.realpathSync(sandbox));
  });
});

describe('stdin 传 prompt', () => {
  it('**把 stdinData 喂进去，并且喂完关闭**', async () => {
    // 不关的话子进程会一直等更多输入——症状是这一轮永远不结束，
    // 而成员锁要等 15 分钟陈旧接管才放得掉。
    const script = path.join(sandbox, 'fake-claude.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash
payload="$(cat)"          # 读到 EOF 才返回；stdin 不关这里就永远卡住
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "\${#payload}"
`, { mode: 0o755 });

    const long = 'x'.repeat(200000);
    const built: BuiltCommand = {
      command: script, args: [], cwd: sandbox, stdin: 'pipe', stdinData: long,
    };
    const result = await runExternalAgent(built, adapter, { onEvent: () => {} });

    expect(result.ok, 'stdin 没关，子进程一直在等输入').toBe(true);
    expect(result.finalText, '喂进去的内容长度对不上').toBe(String(long.length));
  }, 20000);

  it('中文按字节喂，不被截断', async () => {
    const script = path.join(sandbox, 'fake-claude.sh');
    fs.writeFileSync(script, `#!/usr/bin/env bash
payload="$(cat)"
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\\n' "$payload"
`, { mode: 0o755 });

    const cjk = '群聊上下文';
    const built: BuiltCommand = {
      command: script, args: [], cwd: sandbox, stdin: 'pipe', stdinData: cjk,
    };
    const result = await runExternalAgent(built, adapter, { onEvent: () => {} });
    expect(result.finalText).toBe(cjk);
  }, 20000);
});

