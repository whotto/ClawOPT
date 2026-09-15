/**
 * 本机进程执行器：用**真进程**测。mock 出来的子进程不会分块、不会在行中间断开、不会留下孙进程，
 * 而这三件恰好是执行器唯一容易写错的地方。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLocalProcessExecutor, LineSplitter, type ProcessExit } from '../../../../src/runtime/adapters/_shared/process';

let sandbox: string;
beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-proc-')); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

function script(body: string): string {
  const file = path.join(sandbox, 'fake.sh');
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

function launch(command: string, options: { stdin?: 'ignore' | 'pipe'; escalationMs?: number; args?: string[] } = {}) {
  const lines: string[] = [];
  const order: string[] = [];
  const exec = createLocalProcessExecutor({ killEscalationMs: options.escalationMs });
  const proc = exec(
    { command, args: options.args ?? [], cwd: sandbox, env: { PATH: process.env.PATH, HOME: sandbox }, stdin: options.stdin ?? 'ignore' },
    { onStdoutLine: (line) => { lines.push(line); order.push(`line:${line}`); }, onExit: () => order.push('exit') },
  );
  return { proc, lines, order };
}

describe('行切分', () => {
  it('一行被拆成多个数据块时拼回来', async () => {
    const { proc, lines } = launch(script(`printf '{"a":"被切成'\nsleep 0.1\nprintf '两半"}\\n'`));
    await proc.closed;
    expect(lines).toEqual(['{"a":"被切成两半"}']);
  });

  it('结尾没有换行的最后一行也交出来', async () => {
    const { proc, lines } = launch(script(`printf 'last-line'`));
    await proc.closed;
    expect(lines).toEqual(['last-line']);
  });

  it('**只按 LF 切**：行尾 CR 去掉，U+2028 与裸 CR 不是边界', () => {
    const out: string[] = [];
    const splitter = new LineSplitter((line) => out.push(line));
    splitter.push('{"t":"a b"}\r\n{"t":"c\rd"}\n');
    expect(out).toEqual(['{"t":"a b"}', '{"t":"c\rd"}']);
  });

  it('多字节 UTF-8 字符跨块不被切坏', () => {
    const out: string[] = [];
    const splitter = new LineSplitter((line) => out.push(line));
    const bytes = Buffer.from('中文\n', 'utf8');
    splitter.push(bytes.subarray(0, 2));
    splitter.push(bytes.subarray(2));
    expect(out).toEqual(['中文']);
  });
});

describe('完成与停止', () => {
  it('**close 才算完成**：exit 之后还在排空的输出不会丢', async () => {
    // 子进程先 fork 一个孙进程继续写 stdout，自己马上退出：exit 先到，最后一行在 exit 之后才到。
    const { proc, lines, order } = launch(script(`( sleep 0.3; echo tail-after-exit ) &\necho first`));
    const exit = await proc.closed;
    expect(exit.code).toBe(0);
    expect(lines).toEqual(['first', 'tail-after-exit']);
    expect(order.indexOf('exit'), 'exit 应当先于最后一行').toBeLessThan(order.indexOf('line:tail-after-exit'));
  });

  it('停止整个进程组：孙进程握着 stdout 也停得住（SIGINT 被忽略时 1.5 秒内 SIGKILL）', async () => {
    const started = Date.now();
    const { proc } = launch(script(`trap '' INT\n( trap '' INT; sleep 30 ) &\nsleep 30`), { escalationMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const exit: ProcessExit = await proc.terminate();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(exit.signal === 'SIGKILL' || exit.code !== 0).toBe(true);
  });

  it('命令不存在：closed 以 spawnError 收尾，不抛', async () => {
    const { proc } = launch(path.join(sandbox, 'no-such-binary'));
    const exit = await proc.closed;
    expect(exit.spawnError?.code).toBe('ENOENT');
  });

  it('stdin 为 ignore 时子进程读到 EOF（不会白等 3 秒）', async () => {
    const started = Date.now();
    const { proc, lines } = launch(script(`read -t 5 x && echo "got:$x" || echo eof`));
    await proc.closed;
    expect(lines).toEqual(['eof']);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('pipe：写进去、关掉 stdin，子进程读到完整中文内容', async () => {
    const { proc, lines } = launch(script(`cat`), { stdin: 'pipe' });
    proc.write('中文按字节喂\n');
    proc.endStdin();
    await proc.closed;
    expect(lines).toEqual(['中文按字节喂']);
  });

  it('stderr 只留脱敏后的尾巴', async () => {
    const { proc } = launch(script(`echo "token Bearer abcdefghijklmnopqrstu at ${os.homedir()}/x" >&2; exit 3`));
    const exit = await proc.closed;
    expect(exit.code).toBe(3);
    expect(proc.stderrTail()).not.toContain('abcdefghijklmnopqrstu');
    expect(proc.stderrTail()).not.toContain(os.homedir());
  });
});
