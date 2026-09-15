/**
 * 记忆浏览的管理面（spec 06 §4.6 Admin surface）：**全部管理员**（`requireAdminAuth`），member 403。
 *
 * 界面上的动作是人发起的：编辑、删除、「记住」都带 `explicitUserAction`（不经意图闸门），操作者记 `user:<用户名>`，
 * 仍然走同一条写入路径（supersede、版本号、审计），不另开后门。版本号不符回 412 + 当前卡片。
 */
import type express from 'express';

import { getRequestIdentity, type AuthMiddleware } from '../core/auth';
import { buildStructuredApiError, type RouteApp } from '../core/http';
import type { MemoryService } from './memory-service';
import { MemoryError, type MemoryHostContext, type MemoryScopeRef } from './types';

export type MemoryRoutesDeps = {
  auth: AuthMiddleware;
  memory: MemoryService;
};

const STATUS: Record<string, number> = {
  'memoryService.ephemeralStore': 503,
  'memoryService.targetNotFound': 404,
  'memoryService.notFound': 404,
  'memoryService.revisionMismatch': 412,
  'memoryService.revisionRequired': 412,
  'memoryService.targetNotActive': 409,
  'memoryService.concurrentWrite': 409,
  'memoryService.batchConflict': 409,
  'memoryService.scopeNotWritable': 403,
  'memoryService.explicitIntentRequired': 403,
  'memoryService.forgetIntentRequired': 403,
  'memoryService.forgetAllIntentRequired': 403,
};

const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;

function detailParams(detail: Record<string, unknown>) {
  const params: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) params[key] = value as string | number | boolean | null;
  }
  return params;
}

export function registerMemoryRoutes(app: RouteApp, ctx: MemoryRoutesDeps): void {
  const { memory } = ctx;
  const admin = ctx.auth.requireAdminAuth;

  const handle = (fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler => (req, res) => {
    Promise.resolve().then(() => fn(req, res)).catch((error) => {
      if (res.headersSent) return;
      if (error instanceof MemoryError) {
        const status = STATUS[error.code] ?? 400;
        const id = typeof error.detail.id === 'string' ? error.detail.id : typeof req.params.id === 'string' ? req.params.id : null;
        const current = status === 412 && id ? memory.getCard(id) : null;
        res.status(status).json({ ...buildStructuredApiError(error.code, error.message, detailParams(error.detail)), ...(current ? { current } : {}) });
        return;
      }
      console.error(`[Memory] request failed: ${(error as Error)?.name ?? 'Error'}`);
      res.status(500).json(buildStructuredApiError('memoryService.internalError'));
    });
  };

  const actorOf = (req: express.Request) => {
    const identity = getRequestIdentity(req);
    return `user:${identity.username ?? (identity.implicit ? 'owner' : 'unknown')}`;
  };

  /** 界面动作的宿主上下文：只对这张卡（或指定作用域）有读写权，人显式发起。 */
  const uiContext = (req: express.Request, profileId: string, scope: MemoryScopeRef): MemoryHostContext => ({
    profileId,
    origin: { host: 'clawopt', namespace: 'memory-browser', contextId: 'ui' },
    recallScopes: [scope],
    writeScopes: [scope],
    defaultWriteScope: scope,
    evidence: [],
    policy: 'automatic',
    actor: actorOf(req),
    explicitUserAction: true,
  });

  const requireCard = (id: string) => {
    const card = memory.getCard(id);
    if (!card) throw new MemoryError('memoryService.notFound', 'memory card not found');
    return card;
  };

  const profileParam = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !PROFILE_ID.test(value)) throw new MemoryError('memoryService.invalidInput', 'invalid profileId');
    return value;
  };

  app.get('/api/memory/profiles', admin, handle((_req, res) => {
    res.json({ success: true, profiles: memory.profiles(), store: memory.storeInfo() });
  }));

  app.get('/api/memory/cards', admin, handle((req, res) => {
    res.json({
      success: true,
      ...memory.list({
        profileId: profileParam(req.query.profileId),
        query: typeof req.query.q === 'string' ? req.query.q : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        limit: Number(req.query.limit) || undefined,
        offset: Number(req.query.offset) || undefined,
      }),
    });
  }));

  app.get('/api/memory/cards/:id', admin, handle((req, res) => {
    const card = requireCard(String(req.params.id));
    res.json({ success: true, card, revisions: memory.revisionChain(card.id), audit: memory.auditEvents({ nodeId: card.id, limit: 50 }) });
  }));

  app.get('/api/memory/graph', admin, handle((req, res) => {
    const profileId = profileParam(req.query.profileId);
    if (!profileId) throw new MemoryError('memoryService.invalidInput', 'profileId is required');
    res.json({ success: true, ...memory.graph(profileId, { includeDeleted: req.query.includeDeleted === '1' }) });
  }));

  app.post('/api/memory/cards', admin, handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const profileId = profileParam(body.profileId);
    if (!profileId) throw new MemoryError('memoryService.invalidInput', 'profileId is required');
    const scope = (body.scope ?? { type: 'profile', id: profileId }) as MemoryScopeRef;
    const result = await memory.write(uiContext(req, profileId, scope), {
      operations: [{
        op: 'create',
        kind: String(body.kind ?? ''),
        itemKey: typeof body.itemKey === 'string' ? body.itemKey : undefined,
        title: body.title as string,
        content: body.content as string,
        value: body.value,
        tags: body.tags as string[] | undefined,
        entities: body.entities as string[] | undefined,
      }],
    });
    res.status(201).json({ success: true, result: result.results[0] });
  }));

  app.patch('/api/memory/cards/:id', admin, handle(async (req, res) => {
    const card = requireCard(String(req.params.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await memory.write(uiContext(req, card.profileId, card.scope), {
      operations: [{
        op: 'update',
        targetId: card.id,
        expectedRevision: body.expectedRevision as number,
        title: typeof body.title === 'string' ? body.title : undefined,
        content: typeof body.content === 'string' ? body.content : undefined,
        tags: body.tags as string[] | undefined,
      }],
    });
    res.json({ success: true, result: result.results[0] });
  }));

  app.delete('/api/memory/cards/:id', admin, handle(async (req, res) => {
    const card = requireCard(String(req.params.id));
    const body = (req.body ?? {}) as Record<string, unknown>;
    const expectedRevision = body.expectedRevision ?? req.query.expectedRevision;
    const result = await memory.write(uiContext(req, card.profileId, card.scope), {
      operations: [{ op: 'delete', targetId: card.id, expectedRevision: expectedRevision as number, hard: false }],
    });
    res.json({ success: true, result: result.results[0] });
  }));

  app.get('/api/memory/audit', admin, handle((req, res) => {
    res.json({ success: true, events: memory.auditEvents({ profileId: profileParam(req.query.profileId), limit: Number(req.query.limit) || undefined }) });
  }));
}
