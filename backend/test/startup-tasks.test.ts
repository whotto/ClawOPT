/**
 * 启动一次性任务：按序执行、完成记录落盘、坏记录整批拒跑、首个失败即停、日志不带原始错误文本。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildStartupTasks, runStartupTasks, type StartupTask } from '../src/bootstrap/startup-tasks';

let dir: string;
let statePath: string;
let logs: string[];
const log = (message: string) => logs.push(message);
const now = () => new Date('2026-09-14T00:00:00.000Z');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-startup-tasks-'));
  statePath = path.join(dir, 'startup-tasks.json');
  logs = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runStartupTasks', () => {
  it('登记表的 id 清单与顺序（只追加，不改不删）', () => {
    const tasks = buildStartupTasks({ db: { getConfig: () => undefined }, userStore: {} as any, log });
    expect(tasks.map((task) => `${task.id}@${task.scope}`)).toEqual(['auth.login-password-to-super-admin@clawopt-data']);
  });

  it('零任务时不创建记录文件', async () => {
    const outcome = await runStartupTasks({ tasks: [], statePath, log });
    expect(outcome).toEqual({ status: 'ok', ran: [], skipped: [] });
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('按顺序跑，记录完成；第二次启动跳过已完成的', async () => {
    const order: string[] = [];
    const tasks: StartupTask[] = [
      { id: 'a', scope: 'clawopt-data', run: () => { order.push('a'); } },
      { id: 'b', scope: 'openclaw-home', run: async () => { order.push('b'); } },
    ];
    expect(await runStartupTasks({ tasks, statePath, log, now })).toEqual({ status: 'ok', ran: ['a', 'b'], skipped: [] });
    expect(order).toEqual(['a', 'b']);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toEqual({
      version: 1,
      completed: {
        a: { scope: 'clawopt-data', completedAt: '2026-09-14T00:00:00.000Z' },
        b: { scope: 'openclaw-home', completedAt: '2026-09-14T00:00:00.000Z' },
      },
    });
    expect(await runStartupTasks({ tasks, statePath, log, now })).toEqual({ status: 'ok', ran: [], skipped: ['a', 'b'] });
    expect(order).toEqual(['a', 'b']);
  });

  it('第一个失败就停：后面的不跑，失败的不记完成；日志只有 id 与 errorCode', async () => {
    const third = vi.fn();
    const failure = Object.assign(new Error('cannot read /home/me/.openclaw/openclaw.json apiKey=sk-live'), { errorCode: 'migration.configUnreadable' });
    const tasks: StartupTask[] = [
      { id: 'first', scope: 'clawopt-data', run: () => {} },
      { id: 'second', scope: 'clawopt-data', run: () => { throw failure; } },
      { id: 'third', scope: 'clawopt-data', run: third },
    ];
    const outcome = await runStartupTasks({ tasks, statePath, log, now });
    expect(outcome).toEqual({ status: 'failed', ran: ['first'], skipped: [], failedTask: 'second', errorCode: 'migration.configUnreadable' });
    expect(third).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf-8')).completed)).toEqual(['first']);
    expect(logs).toContain('[StartupTasks] task second failed: migration.configUnreadable');
    expect(logs.join('\n')).not.toContain('sk-live');
    expect(logs.join('\n')).not.toContain('.openclaw');
  });

  it('没有 errorCode 的异常记成 startupTasks.taskFailed，同样不打原文', async () => {
    const tasks: StartupTask[] = [{ id: 'x', scope: 'clawopt-data', run: () => { throw new Error('raw secret text'); } }];
    const outcome = await runStartupTasks({ tasks, statePath, log });
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'startupTasks.taskFailed' });
    expect(logs.join('\n')).not.toContain('raw secret text');
  });

  it.each([
    ['不是 JSON', '{ "version": 1, '],
    ['版本不对', JSON.stringify({ version: 2, completed: {} })],
    ['completed 形状不对', JSON.stringify({ version: 1, completed: [] })],
    ['记录缺字段', JSON.stringify({ version: 1, completed: { a: { scope: 'clawopt-data' } } })],
  ])('记录文件损坏（%s）：整批拒跑，一个任务都不执行，文件原样保留', async (_label, content) => {
    fs.writeFileSync(statePath, content);
    const run = vi.fn();
    const outcome = await runStartupTasks({ tasks: [{ id: 'a', scope: 'clawopt-data', run }], statePath, log });
    expect(outcome).toEqual({ status: 'refused', errorCode: 'startupTasks.stateCorrupt' });
    expect(run).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, 'utf-8')).toBe(content);
  });

  it('记录里的 scope 与登记不符：拒跑', async () => {
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, completed: { a: { scope: 'openclaw-home', completedAt: 'x' } } }));
    const run = vi.fn();
    const outcome = await runStartupTasks({ tasks: [{ id: 'a', scope: 'clawopt-data', run }, { id: 'b', scope: 'clawopt-data', run }], statePath, log });
    expect(outcome).toEqual({ status: 'refused', errorCode: 'startupTasks.scopeMismatch' });
    expect(run).not.toHaveBeenCalled();
  });

  it('登记表里 id 重复：拒跑', async () => {
    const run = vi.fn();
    const outcome = await runStartupTasks({ tasks: [{ id: 'a', scope: 'clawopt-data', run }, { id: 'a', scope: 'clawopt-data', run }], statePath, log });
    expect(outcome).toEqual({ status: 'refused', errorCode: 'startupTasks.invalidRegistry' });
    expect(run).not.toHaveBeenCalled();
  });
});
