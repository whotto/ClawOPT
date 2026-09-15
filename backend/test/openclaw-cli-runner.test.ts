/**
 * OpenClaw CLI 调用口：参数数组、profile 注入、JSON 解析、错误分类与脱敏、写操作串行。
 */
import os from 'os';
import { describe, expect, it } from 'vitest';
import {
  classifyCliFailure,
  createOpenClawCliRunner,
  OpenClawCliError,
  parseCliJson,
  parseCliJsonLines,
  redactCliText,
  resolveCliProfile,
  type CliExec,
} from '../src/openclaw';

function failingExec(stderr: string, extra: Record<string, unknown> = {}): CliExec {
  return async () => {
    const error = Object.assign(new Error('Command failed'), { code: 1, stderr, stdout: '' }, extra);
    throw error;
  };
}

describe('parseCliJson', () => {
  it('整段 JSON 直接解析', () => {
    expect(parseCliJson('{"a":1}\n')).toEqual({ a: 1 });
  });

  it('前面有人话行时从第一个 JSON 行开始解析', () => {
    const stdout = 'Updated config: ~/.openclaw/openclaw.json\n  Backup: x.bak\n{\n  "aliases": {"fast": "openai/gpt"}\n}\n';
    expect(parseCliJson(stdout)).toEqual({ aliases: { fast: 'openai/gpt' } });
  });

  it('带 ANSI 颜色也能解析', () => {
    expect(parseCliJson('\x1b[36m[1,2]\x1b[39m')).toEqual([1, 2]);
  });

  it('不是 JSON 抛 openclaw.cliBadJson', () => {
    expect(() => parseCliJson('Saved.')).toThrowError(OpenClawCliError);
    try {
      parseCliJson('');
    } catch (error) {
      expect((error as OpenClawCliError).errorCode).toBe('openclaw.cliBadJson');
    }
  });

  it('逐行 JSON 跳过坏行', () => {
    expect(parseCliJsonLines('{"type":"meta"}\nnot json\n{"type":"log","level":"info"}\n')).toEqual([
      { type: 'meta' },
      { type: 'log', level: 'info' },
    ]);
  });
});

describe('redactCliText', () => {
  it('抹掉声明的密钥、参数形状、家目录与 sk- 形状', () => {
    const home = os.homedir();
    const text = `failed for token SECRET-VALUE-123 at ${home}/.openclaw/openclaw.json --bot-token 12345:abc key sk-abcdefghijklmnop`;
    const out = redactCliText(text, ['SECRET-VALUE-123']);
    expect(out).not.toContain('SECRET-VALUE-123');
    expect(out).not.toContain('12345:abc');
    expect(out).not.toContain('sk-abcdefghijklmnop');
    expect(out).not.toContain(home);
    expect(out).toContain('~/.openclaw/openclaw.json');
  });
});

describe('classifyCliFailure', () => {
  it.each([
    ['Reason: Unknown command: openclaw skills foo.', 'openclaw.cliUnsupported'],
    ['gateway connect failed: GatewayClientRequestError: scope upgrade pending approval', 'openclaw.pairingRequired'],
    ['Error: gateway connect failed: connect ECONNREFUSED 127.0.0.1:18789', 'openclaw.gatewayUnreachable'],
    ['No MCP server named "nope" in openclaw.json', 'openclaw.notFound'],
    ['something else broke', 'openclaw.cliFailed'],
  ])('%s → %s', (text, code) => {
    expect(classifyCliFailure(text, null)).toBe(code);
  });

  it('ENOENT → cliMissing；被杀 → cliTimeout', () => {
    expect(classifyCliFailure('', Object.assign(new Error('spawn'), { code: 'ENOENT' }))).toBe('openclaw.cliMissing');
    expect(classifyCliFailure('', Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }))).toBe('openclaw.cliTimeout');
  });
});

describe('createOpenClawCliRunner', () => {
  it('参数原样作为 argv 传递，profile 注入在最前面', async () => {
    const calls: string[][] = [];
    const runner = createOpenClawCliRunner({
      profile: 'clawopt-test',
      resolveExecutable: () => '/usr/bin/openclaw',
      exec: async (_file, args) => {
        calls.push(args);
        return { stdout: '{"ok":true}', stderr: '' };
      },
    });
    const name = 'x; rm -rf / `whoami`';
    await expect(runner.runJson(['cron', 'add', '--name', name, '--json'])).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual(['--profile', 'clawopt-test', 'cron', 'add', '--name', name, '--json']);
  });

  it('没设 profile 时不注入', async () => {
    const runner = createOpenClawCliRunner({ profile: null, resolveExecutable: () => 'oc', exec: async (_f, args) => ({ stdout: args.join(' '), stderr: '' }) });
    await expect(runner.run(['mcp', 'list'])).resolves.toEqual({ stdout: 'mcp list', stderr: '' });
  });

  it('非法 profile 名被拒', () => {
    expect(resolveCliProfile('clawopt-p5test')).toBe('clawopt-p5test');
    expect(() => resolveCliProfile('../../etc')).toThrowError(OpenClawCliError);
  });

  it('找不到 CLI → openclaw.cliMissing', async () => {
    const runner = createOpenClawCliRunner({ profile: null, resolveExecutable: () => { throw new Error('nope /home/user/secret'); } });
    await expect(runner.run(['mcp', 'list'])).rejects.toMatchObject({ errorCode: 'openclaw.cliMissing' });
  });

  it('失败时 errorDetail 已脱敏，errorCode 已分类', async () => {
    const runner = createOpenClawCliRunner({
      profile: null,
      resolveExecutable: () => 'oc',
      exec: failingExec('gateway connect failed: pairing required (token TOPSECRET-TOKEN)'),
    });
    const error = await runner.run(['channels', 'add', '--token', 'TOPSECRET-TOKEN'], { secrets: ['TOPSECRET-TOKEN'] }).catch((e) => e);
    expect(error).toBeInstanceOf(OpenClawCliError);
    expect(error.errorCode).toBe('openclaw.pairingRequired');
    expect(error.detail).not.toContain('TOPSECRET-TOKEN');
  });

  it('写操作串行：前一个没结束，后一个不开始；前一个失败不堵住后面', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = createOpenClawCliRunner({
      profile: null,
      resolveExecutable: () => 'oc',
      exec: async (_file, args) => {
        order.push(`start:${args[0]}`);
        if (args[0] === 'first') {
          await gate;
          order.push('end:first');
          throw Object.assign(new Error('boom'), { code: 1, stderr: 'boom', stdout: '' });
        }
        order.push(`end:${args[0]}`);
        return { stdout: '', stderr: '' };
      },
    });
    const first = runner.run(['first'], { mutating: true }).catch(() => 'failed');
    const second = runner.run(['second'], { mutating: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['start:first']);
    release();
    await expect(first).resolves.toBe('failed');
    await second;
    expect(order).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });
});
