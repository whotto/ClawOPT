/**
 * 不启动服务、不打开数据库，只把应用「组装一遍」，拿到路由登记表。
 *
 * 注册路由时各注册器只从 ctx 上**解构**函数，并不调用；所以一个「取什么都给一个可调用
 * 替身」的 Proxy 足以让 `buildApp()` 走完。替身被**调用**就抛——若组装过程意外执行了
 * 业务代码，会立刻暴露，而不是生成一份建立在假数据上的清单。
 *
 * 同一路径的属性每次取到同一个替身，因此按函数身份比对的东西（requireAdminAuth）稳定。
 * OpenAPI 生成与路由相关的测试都用它。
 */
import type { RouteRecord } from '../core/http';
import { buildApp } from './app';
import type { AppContext } from './context';

export function createRegistrationContext(overrides: Record<string, unknown> = {}): AppContext {
  const cache = new Map<string, unknown>();
  const make = (name: string): unknown => {
    const target = function registrationStub() {
      throw new Error(`registration stub ${name} was called`);
    };
    return new Proxy(target, {
      get(_target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        // `app.use(fn)` 用 `fn.handle && fn.set` 判断是不是子应用；替身要老实地说「不是」。
        if (prop === 'handle' || prop === 'set') return undefined;
        if (name === 'ctx' && prop in overrides) return overrides[prop];
        const key = `${name}.${prop}`;
        if (!cache.has(key)) cache.set(key, make(key));
        return cache.get(key);
      },
    });
  };
  return make('ctx') as AppContext;
}

export function collectRouteRecords(): RouteRecord[] {
  return buildApp(createRegistrationContext()).routes.list();
}
