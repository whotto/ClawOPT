/**
 * 单聊会话的组织、标题、导出、分叉（P1b）。
 *
 * 授权：
 * - 分类的建改删只动**自己的**分类（按用户存，见 `session-org-store.ts`），登录即可；
 * - 按会话的操作（挪分类、置顶、归档、改标题、导出）先过 `chatSessionParamGuard`：看不见的会话 403；
 * - 组织视图 `GET /api/session-organization` 只回看得见的会话；
 * - 分叉会新建一个外部运行时单聊，与建会话同级：`requireAdminAuth`。
 */
import { randomBytes, randomUUID } from 'crypto';
import type express from 'express';

import { type AuthMiddleware, getRequestIdentity, type ResourceAccess } from '../../core/auth';
import type { DB, SessionRow } from '../../core/db';
import { buildStructuredApiError, type RouteApp } from '../../core/http';
import type { RunCoordinator, RuntimePlatform } from '../../runtime';
import { externalSessionDefaultWorkspace } from './external-workspace';
import { normalizeExternalSessionConfig, parseExternalSessionConfig } from './external-chat-turn';
import { parseExportFormat, sendSessionExport } from './session-export';
import type { SessionManager } from './session-manager';
import {
  isHumanCreatedSession,
  normalizeCategoryName,
  SESSION_TITLE_MAX_CHARS,
  sessionOrgOwnerKey,
  type SessionOrgStore,
} from './session-org-store';
import { chatSessionParamGuard } from './session-routes';

export const SESSION_ORG_ERROR = {
  categoryNameEmpty: 'sessionOrg.errors.categoryNameEmpty',
  categoryNameTooLong: 'sessionOrg.errors.categoryNameTooLong',
  categoryNameTaken: 'sessionOrg.errors.categoryNameTaken',
  categoryNotFound: 'sessionOrg.errors.categoryNotFound',
  sessionNotFound: 'sessionOrg.errors.sessionNotFound',
  titleInvalid: 'sessionOrg.errors.titleInvalid',
  exportFormatInvalid: 'sessionOrg.errors.exportFormatInvalid',
  forkUnsupported: 'sessionOrg.errors.forkUnsupported',
  forkBusy: 'sessionOrg.errors.forkBusy',
  forkNothingToFork: 'sessionOrg.errors.forkNothingToFork',
} as const;

export type SessionOrgRoutesDeps = {
  db: DB;
  sessionManager: SessionManager;
  sessionOrg: SessionOrgStore;
  access: ResourceAccess;
  auth: Pick<AuthMiddleware, 'requireAdminAuth'>;
  runCoordinator: Pick<RunCoordinator, 'isBusy'>;
  runtimePlatform: Pick<RuntimePlatform, 'registry' | 'hasConfirmedNativeSession'>;
};

function parseCategoryId(raw: unknown): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** 分叉会话的 id：`<父 id>-fork-<时间>-<随机>`，与建会话的 id 规则一致（无空白）。 */
export function forkSessionId(parentId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${parentId}-fork-${stamp}-${randomBytes(3).toString('hex')}`;
}

export type ForkRefusal = { status: number; code: string };

/**
 * 能不能分叉，判据只有这一处：外部运行时单聊、运行时声明了 `nativeFork`、不在运行中、
 * 有消息、父会话在运行时里有 CLI 确认过的原生会话（否则分出来的会话运行时什么都不记得）。
 */
export function checkForkable(deps: Pick<SessionOrgRoutesDeps, 'db' | 'runCoordinator' | 'runtimePlatform'>, session: SessionRow | undefined): ForkRefusal | null {
  if (!session) return { status: 404, code: SESSION_ORG_ERROR.sessionNotFound };
  const runtime = session.external_runtime;
  if (!runtime || !deps.runtimePlatform.registry.get(runtime)?.capabilities?.nativeFork) return { status: 400, code: SESSION_ORG_ERROR.forkUnsupported };
  if (deps.runCoordinator.isBusy(session.id)) return { status: 409, code: SESSION_ORG_ERROR.forkBusy };
  if (deps.db.getMessages(session.id, 1).length === 0 || !deps.runtimePlatform.hasConfirmedNativeSession(runtime, { kind: 'session', sessionId: session.id })) {
    return { status: 409, code: SESSION_ORG_ERROR.forkNothingToFork };
  }
  return null;
}

export function registerSessionOrgRoutes(app: RouteApp, ctx: SessionOrgRoutesDeps): void {
  const guardSessionId = chatSessionParamGuard(ctx, 'id');
  const { requireAdminAuth } = ctx.auth;
  const owner = (req: express.Request) => sessionOrgOwnerKey(getRequestIdentity(req));

  app.get('/api/session-organization', (req, res) => {
    const identity = getRequestIdentity(req);
    const ownerKey = sessionOrgOwnerKey(identity);
    const visible = ctx.sessionManager.getAllSessions().filter((session) => ctx.access.canAccessChatSession(identity, session.id));
    const entries = ctx.sessionOrg.entries(ownerKey);
    const meta = ctx.sessionOrg.allMeta();
    const lastActivity = ctx.sessionOrg.lastActivity();
    const categories = ctx.sessionOrg.listCategories(ownerKey);
    const knownCategories = new Set(categories.map((category) => category.id));
    res.json({
      success: true,
      categories,
      sessions: Object.fromEntries(visible.map((session) => {
        const entry = entries.get(session.id);
        const info = meta.get(session.id) ?? null;
        return [session.id, {
          // 指向已删分类的归属按未分类显示（删分类是事务，这里只是防御）。
          categoryId: entry?.categoryId && knownCategories.has(entry.categoryId) ? entry.categoryId : null,
          archived: entry?.archived ?? false,
          pinnedAt: entry?.pinnedAt ?? null,
          title: info?.title ?? null,
          titleSource: info?.titleSource ?? null,
          humanCreated: isHumanCreatedSession(session, info),
          parentSessionId: info?.parentSessionId && ctx.access.canAccessChatSession(identity, info.parentSessionId) ? info.parentSessionId : null,
          forkPointMessageId: info?.forkPointMessageId ?? null,
          lastActivityAt: lastActivity.get(session.id) ?? (Number(session.updated_at) || null),
        }];
      })),
    });
  });

  app.post('/api/session-categories', (req, res) => {
    const name = normalizeCategoryName(req.body?.name);
    if (!name.ok) return res.status(400).json(buildStructuredApiError(name.reason === 'empty' ? SESSION_ORG_ERROR.categoryNameEmpty : SESSION_ORG_ERROR.categoryNameTooLong));
    const result = ctx.sessionOrg.createCategory(owner(req), name.name, name.key);
    res.status(result.created ? 201 : 200).json({ success: true, ...result });
  });

  app.put('/api/session-categories/:categoryId', (req, res) => {
    const id = parseCategoryId(req.params.categoryId);
    const name = normalizeCategoryName(req.body?.name);
    if (!name.ok) return res.status(400).json(buildStructuredApiError(name.reason === 'empty' ? SESSION_ORG_ERROR.categoryNameEmpty : SESSION_ORG_ERROR.categoryNameTooLong));
    const outcome = id === null ? 'not_found' : ctx.sessionOrg.renameCategory(owner(req), id, name.name, name.key);
    if (outcome === 'not_found') return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.categoryNotFound));
    if (outcome === 'conflict') return res.status(409).json(buildStructuredApiError(SESSION_ORG_ERROR.categoryNameTaken));
    res.json({ success: true });
  });

  app.delete('/api/session-categories/:categoryId', (req, res) => {
    const id = parseCategoryId(req.params.categoryId);
    if (id === null || !ctx.sessionOrg.deleteCategory(owner(req), id)) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.categoryNotFound));
    res.json({ success: true });
  });

  app.put('/api/sessions/:id/category', guardSessionId, (req, res) => {
    if (!ctx.sessionManager.getSession(req.params.id)) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.sessionNotFound));
    const raw = req.body?.categoryId;
    const categoryId = raw === null || raw === undefined ? null : parseCategoryId(raw);
    if (raw !== null && raw !== undefined && categoryId === null) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.categoryNotFound));
    if (ctx.sessionOrg.setCategory(owner(req), req.params.id, categoryId) === 'category_not_found') {
      return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.categoryNotFound));
    }
    res.json({ success: true });
  });

  app.put('/api/sessions/:id/archive', guardSessionId, (req, res) => {
    if (!ctx.sessionManager.getSession(req.params.id)) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.sessionNotFound));
    ctx.sessionOrg.setArchived(owner(req), req.params.id, req.body?.archived !== false);
    res.json({ success: true });
  });

  app.put('/api/sessions/:id/pin', guardSessionId, (req, res) => {
    if (!ctx.sessionManager.getSession(req.params.id)) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.sessionNotFound));
    ctx.sessionOrg.setPinned(owner(req), req.params.id, req.body?.pinned !== false);
    res.json({ success: true });
  });

  // 手动改名：永远赢过自动与运行时提议的标题。对话标题跟着会话走（与改删消息同级，看得见即可改）。
  app.put('/api/sessions/:id/title', guardSessionId, (req, res) => {
    if (!ctx.sessionManager.getSession(req.params.id)) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.sessionNotFound));
    const title = typeof req.body?.title === 'string' ? req.body.title.replace(/\s+/g, ' ').trim() : '';
    if (!title || [...title].length > SESSION_TITLE_MAX_CHARS) return res.status(400).json(buildStructuredApiError(SESSION_ORG_ERROR.titleInvalid));
    const meta = ctx.sessionOrg.proposeTitle(req.params.id, title, 'manual');
    res.json({ success: true, title: meta?.title ?? title, titleSource: 'manual' });
  });

  app.get('/api/sessions/:id/export', guardSessionId, (req, res) => {
    const session = ctx.sessionManager.getSession(req.params.id);
    if (!session) return res.status(404).json(buildStructuredApiError(SESSION_ORG_ERROR.sessionNotFound));
    const format = parseExportFormat(req.query.format);
    if (!format) return res.status(400).json(buildStructuredApiError(SESSION_ORG_ERROR.exportFormatInvalid));
    try {
      sendSessionExport(res, { db: ctx.db.connection(), session, meta: ctx.sessionOrg.getMeta(session.id) }, format);
    } catch (error) {
      if (!res.headersSent) res.status(500).json(buildStructuredApiError('common.unknownError', (error as Error)?.message));
      else res.end();
    }
  });

  app.post('/api/sessions/:id/fork', requireAdminAuth, (req, res) => {
    const parent = ctx.sessionManager.getSession(req.params.id);
    const refusal = checkForkable(ctx, parent);
    if (refusal) return res.status(refusal.status).json(buildStructuredApiError(refusal.code));
    const source = parent!;
    const rawTitle = typeof req.body?.title === 'string' ? req.body.title.replace(/\s+/g, ' ').trim() : '';
    if ([...rawTitle].length > SESSION_TITLE_MAX_CHARS) return res.status(400).json(buildStructuredApiError(SESSION_ORG_ERROR.titleInvalid));

    // 分叉的原生会话按工作目录找（Claude Code 的会话记录挂在工作目录下）：子会话必须用父会话实际用的那个目录。
    const parentConfig = parseExternalSessionConfig(source.external_config);
    const workingDir = parentConfig.workingDir || externalSessionDefaultWorkspace(source.id);
    const childId = forkSessionId(source.id);
    const connection = ctx.db.connection();
    const ownerKey = owner(req);
    const forkPointMessageId = connection.transaction(() => {
      ctx.sessionManager.createSession({
        id: childId,
        agentId: childId,
        name: source.name,
        external_runtime: source.external_runtime,
        external_config: normalizeExternalSessionConfig({ ...parentConfig, workingDir }),
        external_session_id: randomUUID(),
      });
      // 文字记录整份拷过去（父 id 映射到新行），同一个事务：不会出现半截分叉。
      const rows = connection.prepare('SELECT id, parent_id, role, content, process_content, process_streaming, model_used, agent_id, agent_name, run_marker, created_at FROM chat_messages WHERE session_key = ? ORDER BY id ASC')
        .all(source.id) as Array<Record<string, any>>;
      const insert = connection.prepare('INSERT INTO chat_messages (session_key, parent_id, role, content, process_content, process_streaming, model_used, agent_id, agent_name, run_marker, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const idMap = new Map<number, number>();
      let last: number | null = null;
      for (const row of rows) {
        const agentId = row.agent_id === source.agentId ? childId : row.agent_id;
        const inserted = Number(insert.run(childId, row.parent_id ? idMap.get(row.parent_id) ?? null : null, row.role, row.content, row.process_content, row.process_streaming, row.model_used, agentId, row.agent_name, row.run_marker, row.created_at).lastInsertRowid);
        idMap.set(row.id, inserted);
        last = inserted;
      }
      const parentMeta = ctx.sessionOrg.getMeta(source.id);
      ctx.sessionOrg.setOrigin(childId, 'human');
      ctx.sessionOrg.setLineage(childId, { parentSessionId: source.id, forkPointMessageId: last });
      if (rawTitle) ctx.sessionOrg.proposeTitle(childId, rawTitle, 'manual');
      else if (parentMeta?.title && parentMeta.titleSource) ctx.sessionOrg.proposeTitle(childId, parentMeta.title, parentMeta.titleSource);
      const parentEntry = ctx.sessionOrg.entries(ownerKey).get(source.id);
      if (parentEntry?.categoryId) ctx.sessionOrg.setCategory(ownerKey, childId, parentEntry.categoryId);
      return last;
    })();
    res.status(201).json({ success: true, session: ctx.sessionManager.getSession(childId), forkPointMessageId });
  });
}
