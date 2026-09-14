/**
 * 业务事件总线：具名消费者、故障隔离、投递前重新鉴权、publish 返回接收数。
 */
import { describe, it, expect, vi } from 'vitest';
import { EventBus, type ConsumerFailure } from '../src/core/events/event-bus';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('EventBus', () => {
  it('按类型投递，返回接收数', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('webhooks', (event) => { seen.push(`webhooks:${event.type}`); }, { types: ['message.created'] });
    bus.subscribe('audit', (event) => { seen.push(`audit:${event.type}`); });
    expect(bus.publish('message.created', { id: 1 })).toBe(2);
    expect(bus.publish('group.deleted', { id: 'g' })).toBe(1);
    expect(seen).toEqual(['webhooks:message.created', 'audit:message.created', 'audit:group.deleted']);
  });

  it('消费者名字唯一，重复订阅直接抛', () => {
    const bus = new EventBus();
    bus.subscribe('webhooks', () => {});
    expect(() => bus.subscribe('webhooks', () => {})).toThrow(expect.objectContaining({ errorCode: 'events.duplicateConsumer' }));
    expect(() => bus.subscribe('  ', () => {})).toThrow(expect.objectContaining({ errorCode: 'events.consumerNameRequired' }));
  });

  it('一个消费者同步抛错，不影响后面的消费者，也不冒泡到发布方', () => {
    const failures: ConsumerFailure[] = [];
    const bus = new EventBus({ onConsumerError: (failure) => failures.push(failure) });
    const after = vi.fn();
    bus.subscribe('broken', () => { throw new Error('boom'); });
    bus.subscribe('healthy', after);
    expect(() => bus.publish('x', {})).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(failures.map((f) => [f.consumer, f.eventType, f.stage])).toEqual([['broken', 'x', 'handle']]);
  });

  it('异步 reject 被接住并上报，没有未处理的 rejection', async () => {
    const failures: ConsumerFailure[] = [];
    const bus = new EventBus({ onConsumerError: (failure) => failures.push(failure) });
    bus.subscribe('async-broken', async () => { throw new Error('later'); });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(bus.publish('x', {})).toBe(1);
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
    expect(failures[0].consumer).toBe('async-broken');
  });

  it('每次投递前重新鉴权：权限收回后不再投递、不计数', () => {
    const bus = new EventBus();
    let allowed = true;
    const handler = vi.fn();
    bus.subscribe('member-feed', handler, { authorize: () => allowed });
    expect(bus.publish('room.message', {})).toBe(1);
    allowed = false;
    expect(bus.publish('room.message', {})).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('鉴权函数自己抛错：按拒绝处理并上报，别的消费者照收', () => {
    const failures: ConsumerFailure[] = [];
    const bus = new EventBus({ onConsumerError: (failure) => failures.push(failure) });
    const other = vi.fn();
    bus.subscribe('bad-auth', vi.fn(), { authorize: () => { throw new Error('token store down'); } });
    bus.subscribe('other', other);
    expect(bus.publish('x', {})).toBe(1);
    expect(other).toHaveBeenCalled();
    expect(failures.map((f) => f.stage)).toEqual(['authorize']);
  });

  it('上报器自己抛错也隔离', () => {
    const bus = new EventBus({ onConsumerError: () => { throw new Error('reporter down'); } });
    const after = vi.fn();
    bus.subscribe('broken', () => { throw new Error('boom'); });
    bus.subscribe('after', after);
    expect(bus.publish('x', {})).toBe(2);
    expect(after).toHaveBeenCalled();
  });

  it('退订生效；投递途中退订不影响本次名单', () => {
    const bus = new EventBus();
    const second = vi.fn();
    let unsubscribeSecond = () => {};
    bus.subscribe('first', () => unsubscribeSecond());
    unsubscribeSecond = bus.subscribe('second', second);
    expect(bus.publish('x', {})).toBe(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(bus.publish('x', {})).toBe(1);
    expect(bus.consumers()).toEqual(['first']);
  });

  it('默认上报不打印原始错误文本', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = new EventBus();
      bus.subscribe('leaky', () => { throw new Error('payload contained sk-secret'); });
      bus.publish('x', {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain('leaky');
      expect(String(spy.mock.calls[0][0])).not.toContain('sk-secret');
    } finally {
      spy.mockRestore();
    }
  });
});
