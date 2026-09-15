/**
 * 外部运行时底座的 HTTP 接口：运行时管理（安装 / 升级 / 卸载 / 自动升级）、每运行时配置页、
 * 主机能力、运行时目录回收、远程 OpenClaw 成员的令牌与连接测试。
 *
 * **全部仅管理员**（`requireAdminAuth`），唯一例外是成员运行时选择器用的 `GET /api/runtime/member-runtimes`
 * （登录即可，只回 id / 名字 / 在不在）。错误一律 `buildStructuredApiError(messageCode, 脱敏详情)`。
 */
import type { Request, RequestHandler, Response } from 'express';

import { buildStructuredApiError, type RouteApp } from '../core/http';
import { NativeConfigError, RuntimeManagerError, authFilePresence, deleteMcpServer, listMcpServers, listSkills, readNativeFile, saveMcpServers, testMcpServer, writeNativeFile, type NativeFileKey } from './manager';
import { sanitizeProcessOutput } from './manager/process-runner';
import type { RuntimePlatform } from './platform';
import { RemoteOpenClawError, testRemoteOpenClawConnection } from './remote-openclaw';

export type RuntimePlatformRoutesDeps = {
  runtimePlatform: RuntimePlatform;
  auth: { requireAdminAuth: RequestHandler };
};

function sendError(res: Response, error: unknown): void {
  if (error instanceof RuntimeManagerError) {
    const operation = (error as RuntimeManagerError & { operation?: unknown }).operation;
    res.status(error.status).json({ ...buildStructuredApiError(error.messageCode, error.detail ?? error.message), ...(operation ? { operation } : {}) });
    return;
  }
  if (error instanceof NativeConfigError) {
    res.status(error.status).json({ ...buildStructuredApiError(error.messageCode, error.message), ...(error.extra ?? {}) });
    return;
  }
  if (error instanceof RemoteOpenClawError) {
    res.status(400).json(buildStructuredApiError(error.messageCode, error.message));
    return;
  }
  const detail = sanitizeProcessOutput((error as Error)?.message ?? String(error), { maxLines: 4 });
  console.error(`[RuntimePlatform] request failed: ${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'Error'}`);
  res.status(500).json(buildStructuredApiError('runtime.internalError', detail));
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response) => {
  Promise.resolve().then(() => fn(req, res)).catch((error) => sendError(res, error));
};

function fileKey(value: string): NativeFileKey {
  if (value === 'preference' || value === 'config') return value;
  throw new NativeConfigError('runtimeConfig.fileNotDeclared', 404, 'Unknown file key');
}

export function registerRuntimePlatformRoutes(app: RouteApp, ctx: RuntimePlatformRoutesDeps): void {
  const { runtimePlatform } = ctx;
  const { manager } = runtimePlatform;
  const admin = ctx.auth.requireAdminAuth;

  // ---- 运行时管理 ----

  app.get('/api/runtime/runtimes', admin, handle(async (_req, res) => {
    // 首屏用缓存的快照（没探测过的才探测），「刷新」才全部重探。
    const runtimes = await Promise.all(manager.descriptors().map((d) => manager.cachedStatus(d.id) ?? manager.status(d.id)));
    res.json({
      success: true,
      runtimes: runtimes.map((status) => ({ ...status, adapterRegistered: Boolean(runtimePlatform.registry.get(status.id)), lastOperation: manager.lastOperation(status.id) })),
      host: await manager.hostCapabilities(),
    });
  }));

  app.post('/api/runtime/runtimes/refresh', admin, handle(async (_req, res) => {
    const runtimes = await manager.statusAll();
    res.json({
      success: true,
      runtimes: runtimes.map((status) => ({ ...status, adapterRegistered: Boolean(runtimePlatform.registry.get(status.id)), lastOperation: manager.lastOperation(status.id) })),
      host: await manager.hostCapabilities(true),
    });
  }));

  app.post('/api/runtime/runtimes/:id/install', admin, handle(async (req, res) => {
    const result = await manager.install(req.params.id, { mode: 'install' });
    res.json({ success: true, ...result });
  }));

  app.post('/api/runtime/runtimes/:id/update', admin, handle(async (req, res) => {
    const result = await manager.install(req.params.id, { mode: 'update' });
    res.json({ success: true, ...result });
  }));

  app.delete('/api/runtime/runtimes/:id', admin, handle(async (req, res) => {
    const result = await manager.uninstall(req.params.id);
    res.json({ success: true, ...result });
  }));

  app.post('/api/runtime/runtimes/:id/check-update', admin, handle(async (req, res) => {
    res.json({ success: true, update: await manager.checkUpdate(req.params.id) });
  }));

  app.get('/api/runtime/update-policies', admin, handle((_req, res) => {
    res.json({ success: true, policies: manager.updateStatuses() });
  }));

  app.put('/api/runtime/runtimes/:id/update-policy', admin, handle((req, res) => {
    if (typeof req.body?.autoUpdate !== 'boolean') {
      res.status(400).json(buildStructuredApiError('runtime.invalidPolicy', 'autoUpdate must be a boolean'));
      return;
    }
    manager.setAutoUpdate(req.params.id, req.body.autoUpdate);
    res.json({ success: true, policies: manager.updateStatuses() });
  }));

  app.get('/api/runtime/host-capabilities', admin, handle(async (req, res) => {
    res.json({ success: true, host: await manager.hostCapabilities(req.query.refresh === '1') });
  }));

  // ---- 成员运行时选择器（登录即可） ----

  app.get('/api/runtime/member-runtimes', handle(async (_req, res) => {
    const entries = runtimePlatform.registry.list();
    const runtimes = await Promise.all(entries.map(async ({ descriptor, capabilities }) => {
      const status = manager.cachedStatus(descriptor.id) ?? await manager.status(descriptor.id);
      return {
        id: descriptor.id,
        name: descriptor.name,
        kind: descriptor.kind ?? 'cli',
        available: status.installed,
        version: status.version,
        probedAt: status.probedAt,
        // 选择器按能力显示配置项（模式、推理强度），不按运行时名字写 if。
        modes: capabilities?.proxyMode ?? [],
        approvals: Boolean(capabilities?.approvals),
        nativeCompact: Boolean(capabilities?.nativeCompact),
        // 单聊「分叉对话」只对能分叉原生会话的运行时显示。
        nativeFork: Boolean(capabilities?.nativeFork),
      };
    }));
    res.json({ success: true, runtimes });
  }));

  // ---- 每运行时配置页 ----

  app.get('/api/runtime/runtimes/:id/config', admin, handle((req, res) => {
    const descriptor = manager.descriptor(req.params.id);
    const native = descriptor.nativeFiles ?? {};
    const meta = (key: NativeFileKey) => {
      if (!native[key]) return null;
      const view = readNativeFile(descriptor, key);
      return { path: view.path, language: view.language, exists: view.exists };
    };
    let mcp: { supported: boolean; format?: string; editable?: boolean; path?: string } = { supported: false };
    if (native.mcp) {
      try {
        const listed = listMcpServers(descriptor);
        mcp = { supported: true, format: listed.format, editable: listed.editable, path: listed.path };
      } catch {
        mcp = { supported: true, format: native.mcp.format, editable: false };
      }
    }
    res.json({
      success: true,
      runtime: { id: descriptor.id, name: descriptor.name, kind: descriptor.kind ?? 'cli' },
      files: { preference: meta('preference'), config: meta('config') },
      auth: authFilePresence(descriptor),
      mcp,
      skills: listSkills(descriptor),
    });
  }));

  app.get('/api/runtime/runtimes/:id/config/files/:key', admin, handle((req, res) => {
    res.json({ success: true, file: readNativeFile(manager.descriptor(req.params.id), fileKey(req.params.key)) });
  }));

  app.put('/api/runtime/runtimes/:id/config/files/:key', admin, handle((req, res) => {
    const file = writeNativeFile(manager.descriptor(req.params.id), fileKey(req.params.key), {
      content: req.body?.content,
      revision: String(req.body?.revision ?? req.header('if-match') ?? ''),
    });
    res.json({ success: true, file });
  }));

  app.get('/api/runtime/runtimes/:id/mcp', admin, handle((req, res) => {
    res.json({ success: true, ...listMcpServers(manager.descriptor(req.params.id)) });
  }));

  app.put('/api/runtime/runtimes/:id/mcp', admin, handle((req, res) => {
    if (typeof req.body?.text !== 'string' || !req.body.text.trim()) {
      res.status(400).json(buildStructuredApiError('mcp.invalidServer', 'text must be a JSON or YAML map of servers'));
      return;
    }
    res.json({ success: true, servers: saveMcpServers(manager.descriptor(req.params.id), req.body.text) });
  }));

  app.delete('/api/runtime/runtimes/:id/mcp/:name', admin, handle((req, res) => {
    res.json({ success: true, servers: deleteMcpServer(manager.descriptor(req.params.id), req.params.name) });
  }));

  app.post('/api/runtime/runtimes/:id/mcp/:name/test', admin, handle(async (req, res) => {
    await manager.warmup();
    res.json({ success: true, result: await testMcpServer(manager.descriptor(req.params.id), req.params.name, manager.childEnv({})) });
  }));

  // ---- 运行时目录回收 ----

  app.get('/api/runtime/homes', admin, handle((_req, res) => {
    const homes = manager.homes.list();
    const byRuntime: Record<string, number> = {};
    for (const home of homes) byRuntime[home.runtime] = (byRuntime[home.runtime] ?? 0) + 1;
    res.json({ success: true, settings: manager.homes.settings(), total: homes.length, byRuntime });
  }));

  app.put('/api/runtime/homes/settings', admin, handle((req, res) => {
    const idleDays = Number(req.body?.idleDays);
    if (!Number.isFinite(idleDays) || idleDays < 0) {
      res.status(400).json(buildStructuredApiError('runtimeHomes.invalidIdleDays', 'idleDays must be a non-negative number'));
      return;
    }
    res.json({ success: true, settings: manager.homes.saveSettings({ idleDays }) });
  }));

  app.post('/api/runtime/homes/sweep', admin, handle((_req, res) => {
    const ownerExists = manager.homeOwnerExists ?? (() => true);
    const removed = manager.homes.sweep(ownerExists);
    res.json({ success: true, removed });
  }));

  // ---- 远程 OpenClaw 成员 ----

  app.get('/api/runtime/remote-openclaw/members/:groupId/:agentId', admin, handle((req, res) => {
    res.json({ success: true, hasToken: runtimePlatform.remoteSecrets.has(req.params.groupId, req.params.agentId) });
  }));

  app.put('/api/runtime/remote-openclaw/members/:groupId/:agentId/token', admin, handle((req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    // 凭据只进不出：空串 = 不修改（清除走 DELETE）。
    if (token) runtimePlatform.remoteSecrets.set(req.params.groupId, req.params.agentId, token);
    res.json({ success: true, hasToken: runtimePlatform.remoteSecrets.has(req.params.groupId, req.params.agentId) });
  }));

  app.delete('/api/runtime/remote-openclaw/members/:groupId/:agentId/token', admin, handle((req, res) => {
    runtimePlatform.remoteSecrets.set(req.params.groupId, req.params.agentId, null);
    res.json({ success: true, hasToken: false });
  }));

  app.post('/api/runtime/remote-openclaw/test', admin, handle(async (req, res) => {
    const body = req.body ?? {};
    let token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token && typeof body.groupId === 'string' && typeof body.agentId === 'string') {
      token = runtimePlatform.remoteSecrets.get(body.groupId, body.agentId) ?? '';
    }
    const result = await testRemoteOpenClawConnection({
      gatewayUrl: typeof body.gatewayUrl === 'string' ? body.gatewayUrl.trim() : '',
      token,
      trustedLan: body.trustedLan === true,
      remoteAgentId: typeof body.remoteAgentId === 'string' ? body.remoteAgentId.trim() : undefined,
    });
    res.json({ success: true, result: { ...result, detail: result.detail ? sanitizeProcessOutput(result.detail, { maxLines: 3 }) : null } });
  }));
}
