/**
 * 从路由登记表生成 OpenAPI 3.0 文档。
 *
 * 现在登记表里只有 method / path / 模块 / 公开与管理员标记 / 路径参数，
 * 所以文档只描述「有哪些接口、谁能调」，不描述请求体与响应体。
 * 路由挂上 `describeRoute({ schema })` 之后，schema 原样进 `x-clawopt-schema`；
 * 等引入 zod 再在这里把它转换成标准的 requestBody / responses。
 *
 * 不进文档的只有两类：中间件（`use`）与 SPA 兜底 `GET *`——它们不是接口。
 */
import type { RouteRecord } from './route-registry';

type OpenApiParameter = {
  name: string;
  in: 'path';
  required: true;
  schema: { type: 'string' };
};

type OpenApiOperation = {
  operationId: string;
  tags: string[];
  summary?: string;
  parameters?: OpenApiParameter[];
  security: Array<Record<string, string[]>>;
  responses: Record<string, { description: string }>;
  'x-clawopt-public': boolean;
  'x-clawopt-admin-only': boolean;
  'x-clawopt-express-path': string;
  'x-clawopt-order': number;
  'x-clawopt-schema'?: unknown;
};

export type OpenApiDocument = {
  openapi: '3.0.3';
  info: { title: string; version: string; description: string };
  tags: Array<{ name: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Record<string, string>>;
  };
};

/** Express 路径 → OpenAPI 路径与参数名。正则路由按已知形状翻译，认不出的原样保留在扩展字段里。 */
export function toOpenApiPath(record: RouteRecord): { path: string; params: string[] } | null {
  if (record.path === '*') return null;
  if (record.path.startsWith('/^')) {
    // /^\/openclaw\/(.+)/ 这类「前缀 + 一个捕获组」
    const match = /^\/\^((?:\\\/[A-Za-z0-9_-]+)+)\\\/\(\.\+\)\/$/.exec(record.path);
    if (!match) return null;
    return { path: `${match[1].replace(/\\\//g, '/')}/{path}`, params: ['path'] };
  }
  let wildcard = 0;
  const params = [...record.params];
  const converted = record.path
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\*/g, () => {
      const name = wildcard === 0 ? 'wildcard' : `wildcard${wildcard}`;
      wildcard += 1;
      params.push(name);
      return `{${name}}`;
    });
  return { path: converted, params };
}

function operationId(method: string, openApiPath: string): string {
  const slug = openApiPath
    .replace(/[{}]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
  return `${method}${slug[0]?.toUpperCase() ?? ''}${slug.slice(1)}`;
}

export function buildOpenApiDocument(records: RouteRecord[], info: { version: string; cookieName: string }): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  const tags = new Set<string>();

  for (const record of records) {
    if (record.kind !== 'route' || record.method === 'use') continue;
    const converted = toOpenApiPath(record);
    if (!converted) continue;
    tags.add(record.module);
    const operation: OpenApiOperation = {
      operationId: operationId(record.method, converted.path),
      tags: [record.module],
      ...(record.summary ? { summary: record.summary } : {}),
      ...(converted.params.length
        ? { parameters: converted.params.map((name) => ({ name, in: 'path' as const, required: true as const, schema: { type: 'string' as const } })) }
        : {}),
      // 公开接口声明空 security；受保护的接口 cookie 与请求头任一即可。
      security: record.public ? [] : [{ sessionCookie: [] }, { authTokenHeader: [] }, { bearerToken: [] }],
      responses: { default: { description: 'Response shape is not described yet (see the route handler).' } },
      'x-clawopt-public': record.public,
      'x-clawopt-admin-only': record.adminOnly,
      'x-clawopt-express-path': record.path,
      'x-clawopt-order': record.order,
      ...(record.schema ? { 'x-clawopt-schema': record.schema } : {}),
    };
    paths[converted.path] ??= {};
    paths[converted.path][record.method] = operation;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'ClawOPT backend',
      version: info.version,
      description: 'Generated from the backend route registry (npm run openapi:generate). Do not edit by hand.',
    },
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: info.cookieName,
          description: 'httpOnly session cookie issued by POST /api/auth/login (web UI).',
        },
        authTokenHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-ClawOPT-Auth-Token',
          description: 'Session token for CLI and scripts.',
        },
        bearerToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Same session token sent as Authorization: Bearer.',
        },
      },
    },
  };
}
