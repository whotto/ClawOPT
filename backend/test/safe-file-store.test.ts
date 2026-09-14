/**
 * SafeFileStore：读—改—写不丢更新、事务回滚、跨进程锁。
 *
 * 丢更新的形状是「文件永远完整，但少了一次修改」——原子写挡不住它。
 * 下面的并发用例在 updater 里故意让出一次事件循环，模拟真实路由里 await 之后再写；
 * 去掉按路径排队，50 次自增会剩下个位数（已植入缺陷验证过会红）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { SafeFileStore, lockFilePathFor, resolveLockKey } from '../src/core/files/safe-file-store';
import { writeFileAtomicSync } from '../src/core/files/config-atomic-write';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-safe-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(dir, name);
const readJson = (name: string) => JSON.parse(fs.readFileSync(file(name), 'utf-8'));

describe('update / updateJson', () => {
  it('写入 next，返回 updater 给的 result', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), JSON.stringify({ n: 1 }));
    const outcome = await store.updateJson<{ n: number }, string>(file('a.json'), (current) => ({
      next: { n: (current?.n ?? 0) + 1 },
      result: 'ok',
    }));
    expect(outcome).toEqual({ written: true, result: 'ok' });
    expect(readJson('a.json')).toEqual({ n: 2 });
  });

  it('abort 不落盘，但仍把 result 带回来', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{"n":1}');
    const before = fs.statSync(file('a.json')).mtimeMs;
    const outcome = await store.updateJson(file('a.json'), () => ({ abort: true as const, result: 'unchanged' }));
    expect(outcome).toEqual({ written: false, result: 'unchanged' });
    expect(fs.readFileSync(file('a.json'), 'utf-8')).toBe('{"n":1}');
    expect(fs.statSync(file('a.json')).mtimeMs).toBe(before);
  });

  it('序列化与 writeJsonAtomicSync 字节一致（换写入口不改文件内容）', async () => {
    const store = new SafeFileStore();
    const value = { a: [1, 2], b: { c: 'd' } };
    await store.updateJson(file('a.json'), () => ({ next: value }));
    expect(fs.readFileSync(file('a.json'), 'utf-8')).toBe(JSON.stringify(value, null, 2));
  });

  it('50 个并发 updater 不丢任何一次更新（进程内排队）', async () => {
    const store = new SafeFileStore({ crossProcess: false });
    fs.writeFileSync(file('counter.json'), JSON.stringify({ n: 0 }));
    await Promise.all(Array.from({ length: 50 }, () => store.updateJson<{ n: number }>(file('counter.json'), async (current) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { next: { n: (current?.n ?? 0) + 1 } };
    })));
    expect(readJson('counter.json')).toEqual({ n: 50 });
    expect(store.isBusy(file('counter.json'))).toBe(false);
  });

  it('两个互不相识的实例（模拟两个进程）靠跨进程锁互斥', async () => {
    const first = new SafeFileStore({ pollIntervalMs: 2 });
    const second = new SafeFileStore({ pollIntervalMs: 2 });
    fs.writeFileSync(file('counter.json'), JSON.stringify({ n: 0 }));
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).updateJson<{ n: number }>(file('counter.json'), async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { next: { n: (current?.n ?? 0) + 1 } };
    })));
    expect(readJson('counter.json')).toEqual({ n: 20 });
  });

  it('软链与真实路径共用一把锁', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('real.json'), JSON.stringify({ n: 0 }));
    fs.symlinkSync(file('real.json'), file('link.json'));
    expect(resolveLockKey(file('link.json'))).toBe(resolveLockKey(file('real.json')));
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.updateJson<{ n: number }>(file(i % 2 ? 'link.json' : 'real.json'), async (current) => {
      await new Promise((resolve) => setImmediate(resolve));
      return { next: { n: (current?.n ?? 0) + 1 } };
    })));
    expect(readJson('real.json')).toEqual({ n: 20 });
    expect(fs.lstatSync(file('link.json')).isSymbolicLink()).toBe(true);
  });

  it('backup 把旧内容写到 .bak', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{"v":"old"}');
    await store.update(file('a.json'), () => ({ next: '{"v":"new"}' }), { backup: true });
    expect(fs.readFileSync(file('a.json.bak'), 'utf-8')).toBe('{"v":"old"}');
    expect(fs.readFileSync(file('a.json'), 'utf-8')).toBe('{"v":"new"}');
  });

  it('现有 JSON 读不懂时拒绝更新，文件保持原样', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{ "agents": ');
    await expect(store.updateJson(file('a.json'), () => ({ next: {} }))).rejects.toMatchObject({ errorCode: 'files.jsonParseFailed' });
    expect(fs.readFileSync(file('a.json'), 'utf-8')).toBe('{ "agents": ');
  });

  it('updater 抛错：不落盘、锁被释放、后续更新照常', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{"n":1}');
    await expect(store.update(file('a.json'), () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(lockFilePathFor(resolveLockKey(file('a.json'))))).toBe(false);
    await store.update(file('a.json'), () => ({ next: '{"n":2}' }));
    expect(readJson('a.json')).toEqual({ n: 2 });
  });
});

describe('transaction', () => {
  it('多个文件一起写', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{"v":1}');
    const result = await store.transaction([file('b.json'), file('a.json')], (tx) => {
      const a = tx.readJson<{ v: number }>(file('a.json'))!;
      tx.writeJson(file('a.json'), { v: a.v + 1 });
      tx.writeJson(file('b.json'), { fromA: a.v });
      return 'done';
    });
    expect(result).toBe('done');
    expect(readJson('a.json')).toEqual({ v: 2 });
    expect(readJson('b.json')).toEqual({ fromA: 1 });
  });

  it('落盘途中失败：已写的回滚，原本不存在的文件被删掉，原错误抛出', async () => {
    fs.writeFileSync(file('a.json'), '{"v":"a-old"}');
    // 排序后 a.json 先写、c.json 后写；让 c.json 的写入失败。
    const store = new SafeFileStore({
      atomicWrite: (target, contents) => {
        if (target.endsWith('c.json')) throw new Error('disk full');
        writeFileAtomicSync(target, contents);
      },
    });
    fs.writeFileSync(file('b.json'), '{"v":"b-old"}');
    await expect(store.transaction([file('a.json'), file('b.json'), file('c.json')], (tx) => {
      tx.write(file('a.json'), '{"v":"a-new"}');
      tx.write(file('b.json'), '{"v":"b-new"}');
      tx.write(file('c.json'), '{"v":"c-new"}');
    })).rejects.toThrow('disk full');
    expect(fs.readFileSync(file('a.json'), 'utf-8')).toBe('{"v":"a-old"}');
    expect(fs.readFileSync(file('b.json'), 'utf-8')).toBe('{"v":"b-old"}');
    expect(fs.existsSync(file('c.json'))).toBe(false);
  });

  it('新建的文件在回滚时删掉', async () => {
    const store = new SafeFileStore({
      atomicWrite: (target, contents) => {
        if (target.endsWith('z.json')) throw new Error('nope');
        writeFileAtomicSync(target, contents);
      },
    });
    await expect(store.transaction([file('new.json'), file('z.json')], (tx) => {
      tx.write(file('new.json'), '{}');
      tx.write(file('z.json'), '{}');
    })).rejects.toThrow('nope');
    expect(fs.existsSync(file('new.json'))).toBe(false);
  });

  it('拒绝写未加锁的路径，且什么都不落盘', async () => {
    const store = new SafeFileStore();
    await expect(store.transaction([file('a.json')], (tx) => {
      tx.write(file('a.json'), '{}');
      tx.write(file('other.json'), '{}');
    })).rejects.toMatchObject({ errorCode: 'files.unlockedPathWrite' });
    expect(fs.existsSync(file('a.json'))).toBe(false);
    expect(fs.existsSync(file('other.json'))).toBe(false);
  });

  it('fn 抛错时一个文件都不写', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{"v":1}');
    await expect(store.transaction([file('a.json')], (tx) => {
      tx.write(file('a.json'), '{"v":2}');
      throw new Error('changed my mind');
    })).rejects.toThrow('changed my mind');
    expect(readJson('a.json')).toEqual({ v: 1 });
  });

  it('相反顺序声明路径的两个事务并发不会死锁', async () => {
    const store = new SafeFileStore();
    fs.writeFileSync(file('a.json'), '{"n":0}');
    fs.writeFileSync(file('b.json'), '{"n":0}');
    const bump = (order: string[]) => store.transaction(order.map(file), async (tx) => {
      await new Promise((resolve) => setImmediate(resolve));
      for (const name of ['a.json', 'b.json']) {
        const current = tx.readJson<{ n: number }>(file(name))!;
        tx.writeJson(file(name), { n: current.n + 1 });
      }
    });
    await Promise.all(Array.from({ length: 10 }, (_, i) => bump(i % 2 ? ['a.json', 'b.json'] : ['b.json', 'a.json'])));
    expect(readJson('a.json')).toEqual({ n: 10 });
    expect(readJson('b.json')).toEqual({ n: 10 });
  });
});

describe('同步写与跨进程锁', () => {
  it('writeJsonSync 与 writeJsonAtomicSync 结果相同，锁文件不残留', () => {
    const store = new SafeFileStore();
    store.writeJsonSync(file('openclaw.json'), { gateway: { port: 1 } });
    expect(fs.readFileSync(file('openclaw.json'), 'utf-8')).toBe(JSON.stringify({ gateway: { port: 1 } }, null, 2));
    expect(fs.readdirSync(dir)).toEqual(['openclaw.json']);
  });

  it('异步更新进行中时同步写直接拒绝，不插队覆盖', async () => {
    const store = new SafeFileStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = store.update(file('a.json'), async () => {
      await gate;
      return { next: 'async' };
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(() => store.writeFileSync(file('a.json'), 'sync')).toThrow(expect.objectContaining({ errorCode: 'files.lockBusy' }));
    release();
    await pending;
    expect(fs.readFileSync(file('a.json'), 'utf-8')).toBe('async');
  });

  it('另一个活着的进程持锁时等待，超时抛 files.lockTimeout', async () => {
    const target = file('openclaw.json');
    const lockPath = lockFilePathFor(resolveLockKey(target));
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, host: require('os').hostname(), token: 'other', acquiredAt: Date.now() }), { flag: 'wx' });
      process.stdout.write('locked');
      setTimeout(() => {}, 20000);
    `]);
    try {
      await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
      const store = new SafeFileStore({ lockTimeoutMs: 200, pollIntervalMs: 20 });
      expect(() => store.writeFileSync(target, 'x')).toThrow(expect.objectContaining({ errorCode: 'files.lockTimeout' }));
      await expect(store.update(target, () => ({ next: 'y' }))).rejects.toMatchObject({ errorCode: 'files.lockTimeout' });
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
    } finally {
      holder.kill('SIGKILL');
    }
  });

  it('持锁进程已经死了：残留锁被清掉，写入成功', () => {
    const target = file('openclaw.json');
    const lockPath = lockFilePathFor(resolveLockKey(target));
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const deadPid = Number(dead.stdout.toString());
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, host: os.hostname(), token: 'dead', acquiredAt: Date.now() }));
    const store = new SafeFileStore({ lockTimeoutMs: 200 });
    store.writeFileSync(target, 'written');
    expect(fs.readFileSync(target, 'utf-8')).toBe('written');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('锁文件年龄超过 staleLockMs 视为残留（持锁方在别的主机、查不了 pid）', () => {
    const target = file('openclaw.json');
    const lockPath = lockFilePathFor(resolveLockKey(target));
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, host: 'another-host', token: 'x', acquiredAt: 0 }));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const store = new SafeFileStore({ lockTimeoutMs: 200, staleLockMs: 30_000 });
    store.writeFileSync(target, 'ok');
    expect(fs.readFileSync(target, 'utf-8')).toBe('ok');
  });
});

describe('接线：openclaw.json 的写入都经 sharedFileStore', () => {
  it('src/ 里没有绕开 SafeFileStore 直接原子写 configPath 的调用点', () => {
    const SRC = path.resolve(__dirname, '..', 'src');
    const hits: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || full.includes(`${path.sep}core${path.sep}files${path.sep}`)) continue;
        fs.readFileSync(full, 'utf-8').split('\n').forEach((line, index) => {
          if (/write(Json|File)AtomicSync\(\s*configPath\b/.test(line)) hits.push(`${path.relative(SRC, full)}:${index + 1}`);
        });
      }
    };
    walk(SRC);
    expect(hits, `这些 openclaw.json 写入没走 sharedFileStore：\n${hits.join('\n')}`).toEqual([]);
    // 接线点确实存在（不是整体消失才变绿）
    const provisioner = fs.readFileSync(path.join(SRC, 'control', 'agents', 'agent-provisioner.ts'), 'utf-8');
    expect((provisioner.match(/sharedFileStore\.writeJsonSync\(configPath/g) ?? []).length).toBe(4);
  });
});
