/**
 * 只用来「把应用组装出来」的上下文替身。
 *
 * 注册路由时各注册器只从 ctx 上解构函数，并不调用它们；所以一个「取什么都给一个
 * 可调用替身」的 Proxy 足以让 `buildApp()` 走完，而不必打开数据库、碰 `~/.openclaw`。
 * 替身被**调用**时直接抛错——测试若意外跑进了处理器，会立刻看见，而不是拿到一个假成功。
 *
 * 同一路径的属性每次取到的是同一个替身，因此按函数身份比对的东西（如 requireAdminAuth）稳定。
 */
import type { AppContext } from '../../src/bootstrap';

export function createStubContext(overrides: Record<string, unknown> = {}): AppContext {
  const cache = new Map<string, unknown>();
  const make = (name: string): unknown => {
    const target = function stub() {
      throw new Error(`stub ${name} was called`);
    };
    return new Proxy(target, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return undefined;
        // `app.use(fn)` 用 `fn.handle && fn.set` 判断是不是子应用；替身要老实地说「不是」。
        if (prop === 'handle' || prop === 'set') return undefined;
        const key = `${name}.${prop}`;
        if (name === 'ctx' && prop in overrides) return overrides[prop];
        if (!cache.has(key)) cache.set(key, make(key));
        return cache.get(key);
      },
    });
  };
  return make('ctx') as AppContext;
}
