/**
 * Web 终端的纯逻辑守卫：字节环形缓冲、一次性票据、服务端 shell 白名单、伪终端环境白名单。
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  ByteRingBuffer,
  TerminalError,
  TerminalTicketStore,
  buildTerminalEnv,
  createTerminalService,
  detectShells,
  resolveShell,
} from '../../src/workspace/terminal';

describe('字节环形缓冲', () => {
  it('按字节封顶：总量不超过容量，偏移单调递增，被挤掉的计入 start', () => {
    const buffer = new ByteRingBuffer(32);
    for (let i = 0; i < 10; i += 1) buffer.append('0123456789');
    expect(buffer.byteLength).toBeLessThanOrEqual(32);
    expect(buffer.end).toBe(100);
    expect(buffer.start).toBe(100 - buffer.byteLength);
    expect(buffer.sliceFrom().data.endsWith('0123456789')).toBe(true);
  });

  it('单块超过容量只留尾部', () => {
    const buffer = new ByteRingBuffer(16);
    buffer.append('a'.repeat(100));
    expect(buffer.byteLength).toBe(16);
    expect(buffer.start).toBe(84);
    expect(buffer.end).toBe(100);
  });

  it('按偏移补差额；偏移早于起点整段给并标 truncated；偏移已到末尾给空', () => {
    const buffer = new ByteRingBuffer(20);
    buffer.append('hello ');
    const mark = buffer.end;
    buffer.append('world');
    expect(buffer.sliceFrom(mark)).toEqual({ data: 'world', start: mark, end: 11, truncated: false });
    expect(buffer.sliceFrom(buffer.end).data).toBe('');
    buffer.append('x'.repeat(30));
    const slice = buffer.sliceFrom(mark);
    expect(slice.truncated).toBe(true);
    expect(slice.start).toBe(buffer.start);
  });

  it('裁剪不从 UTF-8 多字节字符中间切', () => {
    const buffer = new ByteRingBuffer(16);
    buffer.append('终端终端终端终端'); // 24 字节
    const text = buffer.sliceFrom().data;
    expect(text).not.toContain('�');
    expect(Buffer.byteLength(text)).toBe(buffer.byteLength);
  });
});

describe('一次性票据', () => {
  const alice = { userKey: 'user:1', username: 'alice' };
  const bob = { userKey: 'user:2', username: 'bob' };

  it('只能用一次', () => {
    const store = new TerminalTicketStore();
    const { ticket } = store.issue(alice);
    expect(store.consume(ticket, alice)).not.toBeNull();
    expect(store.consume(ticket, alice)).toBeNull();
  });

  it('过期即作废', () => {
    let now = 1000;
    const store = new TerminalTicketStore({ ttlMs: 30_000, now: () => now });
    const { ticket } = store.issue(alice);
    now += 30_001;
    expect(store.consume(ticket, alice)).toBeNull();
  });

  it('绑定签发的用户：别人拿着它不算数，而且这一次核对后票据作废', () => {
    const store = new TerminalTicketStore();
    const { ticket } = store.issue(alice);
    expect(store.consume(ticket, bob)).toBeNull();
    expect(store.consume(ticket, alice)).toBeNull();
  });

  it('只存哈希：票据原文不在存储里', () => {
    const store = new TerminalTicketStore();
    const { ticket } = store.issue(alice);
    expect(JSON.stringify([...(store as any).tickets.entries()])).not.toContain(ticket);
  });
});

describe('shell 白名单', () => {
  const shells = detectShells({ loginShell: '/bin/zsh', isExecutable: (p) => ['/bin/bash', '/bin/zsh', '/bin/sh'].includes(p) });

  it('探测到的只有候选路径里存在的；登录 shell 恰好在候选里才是默认', () => {
    expect(shells.map((s) => s.id)).toEqual(['bash', 'zsh', 'sh']);
    expect(shells.find((s) => s.isDefault)?.id).toBe('zsh');
    const odd = detectShells({ loginShell: '/tmp/evil', isExecutable: (p) => p === '/bin/sh' || p === '/tmp/evil' });
    expect(odd.map((s) => s.path)).toEqual(['/bin/sh']);
  });

  it('客户端给路径、穿越、未知 id 一律拒绝；不给用默认', () => {
    for (const bad of ['/bin/bash', '../bash', 'bash;rm', 'powershell', 42, { id: 'bash' }]) expect(resolveShell(shells, bad), String(bad)).toBeNull();
    expect(resolveShell(shells, 'bash')?.path).toBe('/bin/bash');
    expect(resolveShell(shells, undefined)?.id).toBe('zsh');
  });

  it('服务层：带路径的 shellId 建会话被拒并记审计', async () => {
    const db = new Database(':memory:');
    // 假 pty：只让可用性探测（`sh -c 'exit 0'`）成功，真正建会话一律抛——被拒的请求不该走到 spawn。
    const fakePty = {
      spawn: (_file: string, args: string[]) => {
        if (args[1] !== 'exit 0') throw new Error('must not spawn');
        return { pid: 1, onData: () => ({ dispose() {} }), onExit: (cb: any) => { setTimeout(() => cb({ exitCode: 0 }), 0); return { dispose() {} }; }, write() {}, resize() {}, kill() {} };
      },
    };
    const service = createTerminalService({
      db: { connection: () => db } as any,
      hostCapabilities: async () => ({}) as any,
      loadPty: () => ({ ok: true, pty: fakePty as any }),
      shells: () => shells.map((s) => ({ ...s })),
    });
    const identity = { userId: 1, username: 'alice', role: 'super_admin' };
    await expect(service.createSession(identity, { shellId: '/bin/bash' })).rejects.toMatchObject({ code: 'terminal.shellNotAllowed' });
    expect(service.audit().some((row) => row.event === 'reject' && row.detail === 'shell not in allowlist')).toBe(true);
    await service.stop();
    expect(TerminalError).toBeTypeOf('function');
  });
});

describe('伪终端环境', () => {
  it('从白名单起步：CLAWOPT_* 与各类凭据变量都不给', () => {
    const env = buildTerminalEnv({
      PATH: '/usr/bin', HOME: '/home/x', LANG: 'zh_CN.UTF-8', LC_ALL: 'C',
      CLAWOPT_DATA_DIR: '.clawopt', CLAWOPT_AUTH_TOKEN: 'secret', OPENAI_API_KEY: 'sk-x', AWS_SECRET_ACCESS_KEY: 'a', GITHUB_TOKEN: 'g',
    }, { id: 'bash', path: '/bin/bash', label: 'bash', isDefault: true });
    expect(Object.keys(env).sort()).toEqual(['COLORTERM', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'SHELL', 'TERM']);
    expect(env.TERM).toBe('xterm-256color');
    expect(env.SHELL).toBe('/bin/bash');
  });
});
