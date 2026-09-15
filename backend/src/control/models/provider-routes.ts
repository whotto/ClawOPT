/**
 * 模型与服务商补强（P5a · F）：目录缓存（刷新预览 / 确认 / 撤销）、可见性、上下文长度覆盖、别名、审计。
 * 读：登录即可；写：admin。编辑类写入都带版本号，冲突 412 + 当前视图。
 */
import type express from 'express';

import { type AuthMiddleware, getRequestIdentity } from '../../core/auth';
import { buildStructuredApiError, readRequestedRevision, REVISION_CONFLICT_ERROR_CODE, type RouteApp } from '../../core/http';
import type { OpenClawCliRunner } from '../../openclaw';
import type { AgentProvisioner } from '../agents/agent-provisioner';
import { ControlInputError, controlHandler, requireString } from '../shared/control-http';
import { CatalogRefreshError, type ModelCatalogStore, type ModelPrefsStore, planCatalogRefresh } from './model-catalog';
import type { ProviderAudit } from './provider-audit';
import { assertProviderId, ProviderRevisionConflict, type ProviderEditor } from './provider-editor';
import { probeProviderCatalog } from './provider-probe';

export type ProviderRoutesDeps = {
  auth: AuthMiddleware;
  agentProvisioner: AgentProvisioner;
  providerEditor: ProviderEditor;
  modelCatalog: ModelCatalogStore;
  modelPrefs: ModelPrefsStore;
  providerAudit: ProviderAudit;
  openclawCli: OpenClawCliRunner;
};

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MODEL_REF_PATTERN = /^[A-Za-z0-9_.:/@+-]{1,200}$/;

export function sendProviderConflict(res: express.Response, error: ProviderRevisionConflict): void {
  res.status(412).json({ ...buildStructuredApiError(REVISION_CONFLICT_ERROR_CODE), current: error.current });
}

export function registerProviderRoutes(app: RouteApp, ctx: ProviderRoutesDeps): void {
  const { agentProvisioner, providerEditor, modelCatalog, modelPrefs, providerAudit, openclawCli } = ctx;
  const { requireAdminAuth } = ctx.auth;

  /** 受保护模型：当前默认模型里属于这个服务商的、以及 openclaw.json 已配置在它名下的。 */
  function protectedModelsOf(providerId: string): string[] {
    const configured = agentProvisioner.readAvailableModels()
      .map((model) => model.id)
      .filter((id) => id.startsWith(`${providerId}/`))
      .map((id) => id.slice(providerId.length + 1));
    return [...new Set(configured)];
  }

  app.get('/api/providers/audit', requireAdminAuth, controlHandler(async (req, res) => {
    const providerId = typeof req.query.provider === 'string' && req.query.provider ? assertProviderId(req.query.provider) : undefined;
    res.json({ success: true, entries: providerAudit.list({ limit: Number(req.query.limit ?? 100), providerId }) });
  }));

  app.get('/api/providers/:id/catalog', controlHandler(async (req, res) => {
    const providerId = assertProviderId(req.params.id);
    const entry = modelCatalog.get(providerId);
    const configured = protectedModelsOf(providerId);
    const catalogSet = new Set([...(entry?.models ?? []), ...(entry?.unavailableModels ?? [])]);
    res.json({
      success: true,
      catalog: entry,
      configured,
      // 已配置却不在目录里的模型：界面标 CUSTOM（不是改名，是上游目录没列出的 ID）。
      custom: entry ? configured.filter((model) => !catalogSet.has(model)) : [],
      visibility: modelPrefs.getAll().get(providerId) ?? { mode: 'all', models: [] },
    });
  }));

  app.post('/api/providers/:id/catalog/refresh', requireAdminAuth, controlHandler(async (req, res) => {
    const providerId = assertProviderId(req.params.id);
    const identity = getRequestIdentity(req);
    const entry = providerEditor.readEntry(providerId);
    if (!entry) throw new ControlInputError('models.providerNotFound', 404);
    const probe = await probeProviderCatalog({ baseUrl: String(entry.baseUrl ?? ''), api: String(entry.api ?? 'openai-completions'), apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : null });
    if (!probe.ok || probe.catalogUnavailable) {
      const errorCode = probe.ok ? 'models.catalogUnavailable' : probe.errorCode;
      providerAudit.record({ identity, providerId, action: 'provider.models.refresh', result: 'failed', details: { errorCode } });
      return res.status(502).json(buildStructuredApiError(errorCode, probe.ok ? null : probe.detail));
    }
    const current = modelCatalog.get(providerId);
    let plan: ReturnType<typeof planCatalogRefresh>;
    try {
      plan = planCatalogRefresh({ currentModels: current?.models ?? [], currentUnavailable: current?.unavailableModels ?? [], fetched: probe.models, protectedModels: protectedModelsOf(providerId) });
    } catch (error) {
      if (error instanceof CatalogRefreshError) {
        providerAudit.record({ identity, providerId, action: 'provider.models.refresh', result: 'failed', details: { errorCode: error.errorCode } });
        return res.status(502).json(buildStructuredApiError(error.errorCode));
      }
      throw error;
    }
    if (plan.requiresConfirmation && current && req.body?.confirm !== true) {
      providerAudit.record({ identity, providerId, action: 'provider.models.refresh.preview', result: 'success', details: { added: plan.diff.added.length, removed: plan.diff.removed.length } });
      return res.json({ success: true, requiresConfirmation: true, diff: plan.diff });
    }
    const applied = modelCatalog.apply(providerId, String(entry.baseUrl ?? ''), plan.next);
    providerAudit.record({ identity, providerId, action: 'provider.models.refresh', result: 'success', details: { added: plan.diff.added.length, removed: plan.diff.removed.length, keptUnavailable: plan.diff.keptUnavailable.length } });
    res.json({ success: true, requiresConfirmation: false, diff: plan.diff, catalog: applied });
  }));

  app.post('/api/providers/:id/catalog/restore', requireAdminAuth, controlHandler(async (req, res) => {
    const providerId = assertProviderId(req.params.id);
    try {
      const catalog = modelCatalog.restore(providerId);
      providerAudit.record({ identity: getRequestIdentity(req), providerId, action: 'provider.models.restore', result: 'success' });
      res.json({ success: true, catalog });
    } catch (error) {
      if (error instanceof CatalogRefreshError) return res.status(409).json(buildStructuredApiError(error.errorCode));
      throw error;
    }
  }));

  app.put('/api/providers/:id/visibility', requireAdminAuth, controlHandler(async (req, res) => {
    const providerId = assertProviderId(req.params.id);
    const mode = req.body?.mode;
    const models = Array.isArray(req.body?.models) ? req.body.models.filter((model: unknown): model is string => typeof model === 'string' && MODEL_REF_PATTERN.test(model)) : [];
    if (mode !== 'all' && mode !== 'include') throw new ControlInputError('models.invalidVisibility');
    if (mode === 'include' && models.length === 0) throw new ControlInputError('models.visibilityNeedsModels');
    modelPrefs.setVisibility(providerId, { mode, models });
    providerAudit.record({ identity: getRequestIdentity(req), providerId, action: 'provider.visibility.update', result: 'success', details: { mode, count: models.length } });
    res.json({ success: true });
  }));

  app.put('/api/providers/:id/context-lengths', requireAdminAuth, controlHandler(async (req, res) => {
    const providerId = assertProviderId(req.params.id);
    const identity = getRequestIdentity(req);
    try {
      const outcome = await providerEditor.setContextLengths(providerId, req.body?.contextLengths, readRequestedRevision(req));
      providerAudit.record({ identity, providerId, action: 'provider.context.update', result: 'success', fields: Object.keys(req.body?.contextLengths ?? {}), revisionBefore: outcome.before, revisionAfter: outcome.after });
      res.json({ success: true, revision: outcome.after });
    } catch (error) {
      if (!(error instanceof ProviderRevisionConflict)) throw error;
      providerAudit.record({ identity, providerId, action: 'provider.context.update', result: 'conflict' });
      sendProviderConflict(res, error);
    }
  }));

  app.get('/api/models/aliases', controlHandler(async (_req, res) => {
    const raw = await openclawCli.runJson<{ aliases?: Record<string, string> }>(['models', 'aliases', 'list', '--json']);
    const aliases = Object.entries(raw.aliases ?? {}).map(([alias, model]) => ({ alias, model })).sort((a, b) => a.alias.localeCompare(b.alias));
    res.json({ success: true, aliases });
  }));

  app.put('/api/models/aliases/:alias', requireAdminAuth, controlHandler(async (req, res) => {
    const alias = requireString(req.params.alias, 'models.invalidAlias', { pattern: ALIAS_PATTERN });
    const model = requireString(req.body?.model, 'models.invalidModelRef', { pattern: MODEL_REF_PATTERN });
    await openclawCli.run(['models', 'aliases', 'add', alias, model], { mutating: true });
    res.json({ success: true });
  }));

  app.delete('/api/models/aliases/:alias', requireAdminAuth, controlHandler(async (req, res) => {
    const alias = requireString(req.params.alias, 'models.invalidAlias', { pattern: ALIAS_PATTERN });
    await openclawCli.run(['models', 'aliases', 'remove', alias], { mutating: true });
    res.json({ success: true });
  }));
}
