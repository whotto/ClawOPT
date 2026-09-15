/**
 * 路由与中间件的注册顺序，逐条对照拆分前的 index.ts。
 *
 * Express 按注册顺序匹配，顺序本身就是行为：一条路由注册在鉴权闸门之前还是之后，
 * 决定了它公不公开。P0 把 1.4 万行的 index.ts 拆成模块时，最容易悄悄变的就是这个。
 *
 * `fixtures/route-order.txt` 不是从新代码生成的——它是拆分前那一版（71b5d59）
 * 真实启动时，用 `--require` 钩住 `express.application.get/post/...` 逐次记下来的清单。
 * 新代码组装出来的顺序必须与它**逐行相同**。
 *
 * 要新增路由：改清单，这一刻就有人看见了顺序与公开性的变化。
 * 相对拆分前的清单，唯一的新增是 P0 加的 `GET /livez`、`GET /readyz`（紧挨 `/health` 之前）。
 * P4a 在 `/api/files` 之后、静态资源之前追加了自动化模块的路由（工作流 / 定时 / 钩子 / Webhook / 看板），
 * 其中 `POST /api/hooks/*` 两条是有意公开的（见 AUTH_PUBLIC_PATHS）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildApp } from '../src/bootstrap';
import { createStubContext } from './helpers/stub-context';

const FIXTURE = path.join(__dirname, 'fixtures', 'route-order.txt');

function registeredOrder() {
  const { routes } = buildApp(createStubContext());
  return routes.list().map((r) => `${r.method.toUpperCase()} ${r.path}`);
}

describe('注册顺序与拆分前逐条一致', () => {
  it('清单相同，顺序相同', () => {
    const expected = fs.readFileSync(FIXTURE, 'utf-8').split('\n').filter(Boolean);
    expect(registeredOrder()).toEqual(expected);
  });

  it('/api 闸门存在；SPA 兜底与错误处理在最后', () => {
    const order = registeredOrder();
    const gate = order.indexOf('USE /api');
    expect(gate, '找不到 /api 闸门').toBeGreaterThan(0);
    // SPA 兜底与错误处理必须在最后
    expect(order[order.length - 2]).toBe('GET *');
    expect(order[order.length - 1]).toBe('USE *');
  });
});
