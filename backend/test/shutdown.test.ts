/**
 * 优雅停机注册表：逆序关闭、单步失败不连累、10 秒强制退出、二次信号立即强制。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createShutdownRegistry, DEFAULT_FORCE_EXIT_MS } from '../src/bootstrap/shutdown';

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdownRegistry', () => {
  it('默认时限是 10 秒', () => {
    expect(DEFAULT_FORCE_EXIT_MS).toBe(10_000);
  });

  it('按注册的逆序关闭，全部成功退出码 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const registry = createShutdownRegistry({ exit, log: () => {} });
    registry.register({ name: 'db', close: () => { order.push('db'); } });
    registry.register({ name: 'http', close: async () => { order.push('http'); } });
    await registry.shutdown('test');
    expect(order).toEqual(['http', 'db']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('某一步失败：后续步骤照常关闭，退出码 1，日志只有步骤名不带错误原文', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const log = vi.fn();
    const registry = createShutdownRegistry({ exit, log });
    registry.register({ name: 'db', close: () => { order.push('db'); } });
    registry.register({ name: 'http', close: () => { throw new Error('secret detail'); } });
    await registry.shutdown('test');
    expect(order).toEqual(['db']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join('\n')).toContain('close failed: http');
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret detail');
  });

  it('超时：对没关完的步骤调 forceClose，退出码 1；已关完的不再强制', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const forcedDb = vi.fn();
    const forcedHttp = vi.fn();
    const registry = createShutdownRegistry({ exit, log: () => {}, forceExitMs: 10_000 });
    registry.register({ name: 'db', close: () => new Promise(() => {}), forceClose: forcedDb });
    registry.register({ name: 'http', close: () => {}, forceClose: forcedHttp });
    void registry.shutdown('test');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forcedDb).toHaveBeenCalledTimes(1);
    expect(forcedHttp).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('shutdown 重复调用只跑一次', async () => {
    const close = vi.fn();
    const exit = vi.fn();
    const registry = createShutdownRegistry({ exit, log: () => {} });
    registry.register({ name: 'http', close });
    await Promise.all([registry.shutdown('a'), registry.shutdown('b')]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('SIGTERM 触发停机；第二次信号立即强制退出', async () => {
    const exit = vi.fn();
    const forceClose = vi.fn();
    const registry = createShutdownRegistry({ exit, log: () => {} });
    registry.register({ name: 'sse', close: () => new Promise(() => {}), forceClose });
    const signals = new EventEmitter();
    registry.installSignalHandlers(signals as any);
    signals.emit('SIGTERM', 'SIGTERM');
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    signals.emit('SIGINT', 'SIGINT');
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('步骤名重复注册直接抛', () => {
    const registry = createShutdownRegistry({ exit: vi.fn(), log: () => {} });
    registry.register({ name: 'http', close: () => {} });
    expect(() => registry.register({ name: 'http', close: () => {} })).toThrow();
  });
});
