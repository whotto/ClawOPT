/**
 * OpenAPI：从路由登记表生成；签入的 backend/openapi.json 必须是最新的。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { renderOpenApiJson } from '../src/bootstrap/openapi';
import { collectRouteRecords } from '../src/bootstrap/route-inventory';
import { buildOpenApiDocument, describeRoute, RouteRegistry, toOpenApiPath } from '../src/core/http';

const COMMITTED = path.resolve(__dirname, '..', 'openapi.json');

describe('backend/openapi.json', () => {
  it('签入的文档与当前路由一致（过期请运行 npm run openapi:generate）', () => {
    expect(fs.readFileSync(COMMITTED, 'utf-8')).toBe(renderOpenApiJson());
  });

  it('除中间件与 SPA 兜底外，每条路由都在文档里，标记与登记表一致', () => {
    const document = JSON.parse(renderOpenApiJson());
    const records = collectRouteRecords().filter((r) => r.kind === 'route' && r.path !== '*');
    let operations = 0;
    for (const operationsByMethod of Object.values<Record<string, any>>(document.paths)) operations += Object.keys(operationsByMethod).length;
    expect(operations).toBe(records.length);

    for (const record of records) {
      const converted = toOpenApiPath(record)!;
      const operation = document.paths[converted.path]?.[record.method];
      expect(operation, `${record.method} ${record.path}`).toBeDefined();
      expect(operation.tags).toEqual([record.module]);
      expect(operation['x-clawopt-public']).toBe(record.public);
      expect(operation['x-clawopt-admin-only']).toBe(record.adminOnly);
      expect(operation.security).toEqual(record.public ? [] : [{ sessionCookie: [] }, { authTokenHeader: [] }, { bearerToken: [] }]);
    }

    const groupMessage = document.paths['/api/groups/{id}/messages/{msgId}'].put;
    expect(groupMessage.parameters.map((p: any) => p.name)).toEqual(['id', 'msgId']);
    expect(document.paths['/api/config'].post['x-clawopt-admin-only']).toBe(true);
    expect(document.paths['/api/config'].get['x-clawopt-admin-only']).toBe(false);
    expect(document.paths['/openclaw/{path}'].get['x-clawopt-public']).toBe(false);
    expect(document.components.securitySchemes.sessionCookie.name).toBe('clawopt_session');
  });
});

describe('toOpenApiPath', () => {
  const record = (p: string, params: string[] = []) => ({ kind: 'route', method: 'get', path: p, module: 'm', public: false, adminOnly: false, order: 0, params }) as any;

  it('参数、通配与已知形状的正则路由', () => {
    expect(toOpenApiPath(record('/api/groups/:id', ['id']))).toEqual({ path: '/api/groups/{id}', params: ['id'] });
    expect(toOpenApiPath(record('/api/files/html-preview/path/:encodedPath/*', ['encodedPath'])))
      .toEqual({ path: '/api/files/html-preview/path/{encodedPath}/{wildcard}', params: ['encodedPath', 'wildcard'] });
    expect(toOpenApiPath(record(String(/^\/openclaw\/(.+)/)))).toEqual({ path: '/openclaw/{path}', params: ['path'] });
    expect(toOpenApiPath(record('*'))).toBeNull();
    expect(toOpenApiPath(record(String(/^\/weird(\d+)$/)))).toBeNull();
  });
});

describe('describeRoute：给以后挂 schema 留的口子', () => {
  it('summary 与 schema 进登记表与文档，且描述中间件本身直接放行', async () => {
    const app = express();
    const registry = new RouteRegistry(app);
    const schema = { body: { kind: 'placeholder-for-zod' } };
    registry.forModule('demo').post('/api/demo/:id', describeRoute({ summary: 'Demo', schema }), (_req, res) => { res.json({ ok: true }); });
    const [recorded] = registry.list();
    expect(recorded).toMatchObject({ method: 'post', path: '/api/demo/:id', module: 'demo', summary: 'Demo', schema, params: ['id'] });

    const document = buildOpenApiDocument(registry.list(), { version: 'test', cookieName: 'c' });
    expect(document.paths['/api/demo/{id}'].post.summary).toBe('Demo');
    expect(document.paths['/api/demo/{id}'].post['x-clawopt-schema']).toEqual(schema);

    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as any;
      const response = await fetch(`http://127.0.0.1:${port}/api/demo/1`, { method: 'POST' });
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});
