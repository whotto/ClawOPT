/**
 * 路由登记表：每一次 `app.get/post/put/patch/delete/use` 都经过这里，
 * 在交给 Express 之前记下 `{ method, path, module, public, adminOnly }`。
 *
 * ## 为什么要有它
 *
 * 拆分之前，「有哪些接口、哪些是公开的」只能靠读 1.4 万行的 index.ts。
 * 鉴权是「默认全保护 + 白名单放行」（见 AGENTS.md），可一条路由到底受不受保护，
 * 取决于它**注册在鉴权闸门之前还是之后**——这件事在代码里是隐形的。
 * 登记表把它变成数据：OpenAPI 从这里生成，鉴权覆盖测试也从这里取路由清单。
 *
 * ## `public` 的判据
 *
 * 与 Express 的实际匹配行为一致，而不是与注释一致：
 * - 注册在任何闸门**之前**的路由：闸门根本跑不到它，算公开；
 * - 注册在闸门之后：路径落在被保护的前缀下、且不在该前缀的白名单里，才算受保护。
 *
 * ## 以后挂 schema
 *
 * `describeRoute({ summary, schema })` 返回一个什么都不做的中间件，放在处理器前面即可：
 * `app.post('/api/x', describeRoute({ schema: { body: zodSchema } }), handler)`。
 * 登记表认得它、把 schema 记进元数据；将来要在这里做校验，只改这一个函数。
 */
import type { Express, RequestHandler } from 'express';

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** 预留给 zod 等校验库：登记表只存，不解释。 */
export type RouteSchema = {
  params?: unknown;
  query?: unknown;
  body?: unknown;
  response?: unknown;
};

export type RouteDescription = {
  summary?: string;
  schema?: RouteSchema;
};

export type RouteRecord = {
  kind: 'route' | 'middleware';
  method: RouteMethod | 'use';
  /** 字符串路径原样保留；正则路由记成 `String(regex)`；无路径的中间件记成 `*`。 */
  path: string;
  module: string;
  public: boolean;
  adminOnly: boolean;
  /** 注册顺序（全局递增）。Express 按这个顺序匹配。 */
  order: number;
  params: string[];
  summary?: string;
  schema?: RouteSchema;
};

/** 注册器拿到的 `app`：只暴露注册方法，拿不到 `listen` 之类的东西。 */
export type RouteApp = Pick<Express, RouteMethod | 'use'>;

const ROUTE_DESCRIPTION = Symbol.for('clawopt.routeDescription');

type DescribedHandler = RequestHandler & { [ROUTE_DESCRIPTION]?: RouteDescription };

export function describeRoute(description: RouteDescription): RequestHandler {
  const handler: DescribedHandler = (_req, _res, next) => next();
  handler[ROUTE_DESCRIPTION] = description;
  return handler;
}

type ProtectedPrefix = { prefix: string; publicPaths: ReadonlySet<string> };

export class RouteRegistry {
  private readonly records: RouteRecord[] = [];
  private readonly protectedPrefixes: ProtectedPrefix[] = [];
  private readonly adminGuards = new Set<unknown>();
  private order = 0;

  constructor(private readonly app: Express) {}

  /**
   * 声明从此刻起 `prefix` 下的路由受登录保护（`publicPaths` 除外）。
   * 必须与真正挂闸门的那一行紧挨着调用——登记表描述的是闸门，不是替代闸门。
   */
  markProtectedPrefix(prefix: string, publicPaths: ReadonlySet<string> = new Set()): void {
    this.protectedPrefixes.push({ prefix, publicPaths });
  }

  /** 把某个中间件认作「仅管理员」。按函数身份比对。 */
  markAdminGuard(guard: unknown): void {
    this.adminGuards.add(guard);
  }

  /** 给某个模块用的 `app`。`module` 进 OpenAPI 的 tags。 */
  forModule(module: string): RouteApp {
    const register = (method: RouteMethod | 'use') => (...args: unknown[]) => {
      this.record(module, method, args);
      return (this.app[method] as (...a: unknown[]) => unknown)(...args);
    };
    return {
      get: register('get'),
      post: register('post'),
      put: register('put'),
      patch: register('patch'),
      delete: register('delete'),
      use: register('use'),
    } as unknown as RouteApp;
  }

  list(): RouteRecord[] {
    return this.records.map((record) => ({ ...record, params: [...record.params] }));
  }

  private record(module: string, method: RouteMethod | 'use', args: unknown[]): void {
    const first = args[0];
    const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
    const rawPath = hasPath ? first : '*';
    const pathText = rawPath instanceof RegExp ? String(rawPath) : Array.isArray(rawPath) ? rawPath.map(String).join(',') : String(rawPath);
    const handlers = (hasPath ? args.slice(1) : args).flat();
    const description = handlers
      .map((handler) => (handler as DescribedHandler)?.[ROUTE_DESCRIPTION])
      .find(Boolean);

    this.records.push({
      kind: method === 'use' ? 'middleware' : 'route',
      method,
      path: pathText,
      module,
      public: this.isPublic(pathText),
      adminOnly: handlers.some((handler) => this.adminGuards.has(handler)),
      order: this.order++,
      params: typeof rawPath === 'string' ? extractPathParams(rawPath) : [],
      ...(description?.summary ? { summary: description.summary } : {}),
      ...(description?.schema ? { schema: description.schema } : {}),
    });
  }

  private isPublic(pathText: string): boolean {
    for (const { prefix, publicPaths } of this.protectedPrefixes) {
      if (pathText === prefix || pathText.startsWith(`${prefix}/`) || pathText.startsWith(`/^\\${prefix}\\/`)) {
        return publicPaths.has(pathText);
      }
    }
    return true;
  }
}

/** `/api/groups/:id/messages/:msgId` → `['id', 'msgId']` */
export function extractPathParams(routePath: string): string[] {
  return [...routePath.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}
