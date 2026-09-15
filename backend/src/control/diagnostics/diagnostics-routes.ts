import fs from 'fs';

import type { RoomEngine } from '../../collab/rooms';
import type { DB } from '../../core/db';
import { buildStructuredApiError, type RouteApp } from '../../core/http';
import { browserWarmupMarkerPath } from '../../core/paths';
import {
  detectOpenClawVersion,
  probeGatewayHealth,
  readOpenClawConfigSafe,
  sanitizeErrorDetail,
} from '../../openclaw';
import { checkRuntimeInvariants, resolveBinaryOnPath, type RuntimePlatform } from '../../runtime';
import { buildDiagnosticsReport } from './diagnostics';

export type DiagnosticsRoutesDeps = {
  db: DB;
  rooms: RoomEngine;
  runtimePlatform: Pick<RuntimePlatform, 'manager'>;
};

export function registerDiagnosticsRoutes(app: RouteApp, ctx: DiagnosticsRoutesDeps): void {
  const { db } = ctx;
  const { groupChatEngine } = ctx.rooms;

  /**
   * 诊断快照。**默认受登录保护**（走 /api 的默认保护 + 白名单机制，不进
   * AUTH_PUBLIC_PATHS）——它带着运行现场，不该匿名可取。
   *
   * 存在的理由：这个产品装在用户自己的主机上，我们看不见。此前排障能拿到的只有
   * 一句截图或者一次 SSH。整份报告在 buildDiagnosticsReport 里过脱敏，工作区绝对
   * 路径里的用户名换成 ~，凭据类字段一律抹掉。
   *
   * TODO(鉴权)：上面「默认受登录保护」与现实不符——这条路由注册在 `registerAuthGate`
   * **之前**，闸门跑不到它，实际是公开的（拆分时由路由登记表核出，见 `route-order` 测试）。
   * P0 只搬代码不改行为，修复另起一次改动。
   */
  app.get('/api/diagnostics', (_req, res) => {
    (async () => {
      // 网关探测是异步的，而报告构造是同步的（同步才好测）。先探完再把结果闭包进去。
      let gateway: { connected: boolean; endpoint?: string } = { connected: false };
      try {
        const config = readOpenClawConfigSafe() ?? {};
        const gatewayUrl = `ws://127.0.0.1:${(config as any)?.gateway?.port || 18789}`;
        const health = await probeGatewayHealth(gatewayUrl);
        gateway = { connected: health.ok, endpoint: gatewayUrl };
      } catch {
        // 探不到就让它以 available:false 出现在报告里，不牵连其余几块。
      }

      // 主机能力：探测失败不牵连其余几块（报告里标 available:false）。
      let host: Awaited<ReturnType<typeof ctx.runtimePlatform.manager.hostCapabilities>> | null = null;
      try {
        host = await ctx.runtimePlatform.manager.hostCapabilities();
      } catch {
        host = null;
      }

      res.json(buildDiagnosticsReport({
        hostCapabilities: () => host,
        readConfig: () => readOpenClawConfigSafe(),
        detectEngineVersion: () => detectOpenClawVersion(),
        gatewayStatus: () => gateway,
        browserHealth: () => ({ state: fs.existsSync(browserWarmupMarkerPath) ? 'warmup-pending' : 'ready' }),
        checkInvariants: () => checkRuntimeInvariants({
          readConfig: () => readOpenClawConfigSafe(),
          listGroupMembers: () => db.listAllGroupMembers() as any,
          listExternalSessions: () => db.listAllExternalSessions() as any,
          heldMemberLocks: () => groupChatEngine.heldMemberLockSnapshot(),
          binaryExists: resolveBinaryOnPath,
          pathExists: (target: string) => fs.existsSync(target),
        }),
      }));
    })().catch((error: unknown) => {
      // 排障工具自己在故障现场崩掉等于没有，所以这里也要给出一份可解析的东西。
      res.status(500).json(buildStructuredApiError(
        'diagnostics.unavailable',
        sanitizeErrorDetail(error),
      ));
    });
  });
}
