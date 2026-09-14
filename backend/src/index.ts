/**
 * ClawOPT 后端入口。这里只做一件事：启动。
 *
 * 组装顺序、中间件与路由的注册顺序在 `bootstrap/app.ts`；
 * 单例与服务的构造在 `bootstrap/context.ts`；各业务模块见 `core/`、`openclaw/`、
 * `runtime/`、`control/`、`workspace/`、`collab/`。
 */
import { startServer } from './bootstrap';

startServer();
