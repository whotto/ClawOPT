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
 * P5a 在认证路由后追加用户路由、末尾追加控制面；P2 在用户路由后追加本地模型代理（`USE /api/runtime-proxy` 请求体解析器
 * 在全局 json 之前，四条代理路由有意公开）与 `/api/runtime/*` 运行时平台路由。
 *
 * **有意删除**（集成 v1.9 合入 P2）：`GET /api/external-runtimes`。它与 `GET /api/runtime/member-runtimes` 是两份运行时清单
 * （探测判据不同：原始 PATH vs 管理器的扩充 PATH），而且注册在登录闸门之前、匿名可达；只留登记处 + 管理器那一份。
 * 所以 v1.9 与 P2 两份历史清单对当前清单是「除这一行外的子序列」。
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
