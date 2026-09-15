import {
  buildStructuredApiError,
  ENDPOINT_CREATE_FAILED_ERROR_CODE,
  ENDPOINT_DELETE_FAILED_ERROR_CODE,
  ENDPOINT_TEST_FAILED_ERROR_CODE,
  MODEL_CREATE_FAILED_ERROR_CODE,
  MODEL_DELETE_FAILED_ERROR_CODE,
  MODEL_DISCOVER_FAILED_ERROR_CODE,
  MODEL_TEST_FAILED_ERROR_CODE,
  MODEL_UPDATE_FAILED_ERROR_CODE,
  readRequestedRevision,
  type RouteApp,
} from '../../core/http';
import { type AuthMiddleware, getRequestIdentity } from '../../core/auth';
import type { AgentProvisioner } from '../agents/agent-provisioner';
import { hiddenModels, type ModelPrefsStore } from './model-catalog';
import type { ProviderAudit } from './provider-audit';
import { ProviderRevisionConflict, type ProviderEditor } from './provider-editor';
import { probeProviderCatalog } from './provider-probe';
import { sendProviderConflict } from './provider-routes';
import { normalizeFallbackList, withConfigReadFallback } from '../agents/agent-settings';
import {
  findImageProviderModel,
  findImageProviderModelByName,
  type ImageGenerationService,
  summarizeImageProviderModels,
} from './image-generation-service';

export type ModelRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  imageGeneration: ImageGenerationService;
  auth: AuthMiddleware;
  providerEditor: ProviderEditor;
  providerAudit: ProviderAudit;
  modelPrefs: ModelPrefsStore;
};

export function registerModelRoutes(app: RouteApp, ctx: ModelRoutesDeps): void {
  const { agentProvisioner, providerEditor, providerAudit, modelPrefs } = ctx;
  const { readOpenClawImageProviderSnapshot } = ctx.imageGeneration;
  // P5a：改配置、花 token 的接口一律 admin（多用户之后 member 只读）。
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/models', (_req, res) => {
    // 配置读不动时退回空列表的旧降级行为，不让这条首屏必调的接口整体 500。
    const { value: models, configReadFailed } = withConfigReadFallback(
      [] as ReturnType<typeof agentProvisioner.readAvailableModels>,
      () => agentProvisioner.readAvailableModels(),
    );
    // 可见性白名单只影响挑选器：按服务商分组算隐藏集（失效时放开），打 `hidden` 标记，不删条目。
    const rules = modelPrefs.getAll();
    const byProvider = new Map<string, string[]>();
    for (const model of models) {
      const slash = model.id.indexOf('/');
      if (slash === -1) continue;
      const provider = model.id.slice(0, slash);
      byProvider.set(provider, [...(byProvider.get(provider) ?? []), model.id.slice(slash + 1)]);
    }
    const hidden = new Set<string>();
    for (const [provider, names] of byProvider) {
      for (const name of hiddenModels(names, rules.get(provider))) hidden.add(`${provider}/${name}`);
    }
    res.json({ success: true, models: models.map((model) => (hidden.has(model.id) ? { ...model, hidden: true } : model)), configReadFailed });
  });

  app.get('/api/models/fallbacks', (_req, res) => {
    try {
      res.json({
        success: true,
        config: agentProvisioner.readGlobalModelConfig(),
      });
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.put('/api/models/fallbacks', requireAdminAuth, async (req, res) => {
    try {
      if (!Array.isArray(req.body?.fallbacks)) {
        return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'fallbacks must be an array'));
      }

      const success = await agentProvisioner.updateGlobalFallbacks(normalizeFallbackList(req.body.fallbacks));
      res.json({
        success: true,
        changed: success,
        config: agentProvisioner.readGlobalModelConfig(),
      });
    } catch (err: any) {
      const detail = typeof err?.message === 'string' ? err.message : '';
      res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail || 'Failed to update fallback models'));
    }
  });

  app.get('/api/models/image-generation', (_req, res) => {
    try {
      res.json({
        success: true,
        config: agentProvisioner.readImageGenerationModelConfig(),
      });
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.get('/api/models/image-generation/providers', async (req, res) => {
    try {
      const snapshot = await readOpenClawImageProviderSnapshot({
        refresh: req.query.refresh === '1',
        allowStaleOnError: true,
      });
      res.json({
        success: true,
        providers: snapshot.providers,
        models: snapshot.models,
        updatedAt: snapshot.updatedAt,
        cache: snapshot.cache || null,
      });
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message || 'Failed to read OpenClaw image generation providers'));
    }
  });

  app.put('/api/models/image-generation', requireAdminAuth, async (req, res) => {
    try {
      const primary = typeof req.body?.primary === 'string' ? req.body.primary : null;
      if (!Array.isArray(req.body?.fallbacks)) {
        return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'fallbacks must be an array'));
      }

      const success = await agentProvisioner.updateImageGenerationModelConfig(
        primary,
        normalizeFallbackList(req.body.fallbacks),
      );
      res.json({
        success: true,
        changed: success,
        config: agentProvisioner.readImageGenerationModelConfig(),
      });
    } catch (err: any) {
      const detail = typeof err?.message === 'string' ? err.message : '';
      res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail || 'Failed to update image generation model'));
    }
  });

  app.post('/api/models/test-image-generation', requireAdminAuth, async (req, res) => {
    try {
      const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : '';
      const modelName = typeof req.body?.modelName === 'string' ? req.body.modelName.trim() : '';
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
      const modelRef = modelId || (endpoint && modelName ? `${endpoint}/${modelName}` : '');
      if (!modelRef) {
        return res.status(400).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'endpoint/modelName or modelId required'));
      }

      const startTime = Date.now();
      const snapshot = await readOpenClawImageProviderSnapshot();
      const matchedNameInput = modelName || modelId || modelRef;
      const matched = findImageProviderModel(snapshot, modelRef) || findImageProviderModelByName(snapshot, matchedNameInput);
      if (!matched) {
        return res.json(buildStructuredApiError(
          MODEL_TEST_FAILED_ERROR_CODE,
          `OpenClaw image_generate provider list does not include "${modelRef}" or model name "${matchedNameInput}". Available image models: ${summarizeImageProviderModels(snapshot)}`
        ));
      }

      const provider = snapshot.providers.find((entry) => entry.id === matched.providerId) || null;
      const exactMatch = matched.id === modelRef;
      res.json({
        success: true,
        lightweight: true,
        message: 'OpenClaw recognizes this image generation model',
        latency: Date.now() - startTime,
        model: matched,
        provider,
        cache: snapshot.cache || null,
        matchMode: exactMatch ? 'exact' : 'modelName',
        warning: !exactMatch
          ? `Model name "${matchedNameInput}" is recognized by OpenClaw image providers as "${matched.id}". Endpoint prefix "${endpoint}" and credentials are not verified by the lightweight check.`
          : provider?.configured === false
            ? 'Provider/model is recognized by OpenClaw. Credentials are not verified by the lightweight check.'
          : null,
      });
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message || 'Failed to validate image generation model'));
    }
  });

  app.post('/api/models/test', requireAdminAuth, async (req, res) => {
    try {
      const { endpoint, modelName } = req.body;
      if (!endpoint || !modelName) {
        return res.status(400).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'endpoint and modelName required'));
      }

      const endpoints = agentProvisioner.getEndpoints();
      const config = endpoints.find((e: any) => e.id === endpoint);
      if (!config) {
        return res.status(404).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, 'Endpoint not found'));
      }

      let baseUrl = config.baseUrl;
      const apiKey = config.apiKey || '';
      const apiType = config.api.toLowerCase();

      let testUrl = '';
      let headers: any = {
        'Content-Type': 'application/json'
      };
      let body: any = {};

      if (apiType.includes('anthropic')) {
        testUrl = `${baseUrl.replace(/\/$/, '')}/messages`;
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = {
          model: modelName,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 5
        };
      } else if (apiType.includes('gemini') || apiType.includes('google')) {
        // key 放头里：查询串会进上游与代理的访问日志。
        testUrl = `${baseUrl.replace(/\/$/, '')}/models/${modelName}:generateContent`;
        headers['x-goog-api-key'] = apiKey;
        body = {
          contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
          generationConfig: { maxOutputTokens: 5 }
        };
      } else if (apiType.includes('ollama')) {
        testUrl = `${baseUrl.replace(/\/$/, '')}/api/chat`; 
        body = {
          model: modelName,
          messages: [{ role: 'user', content: 'hello' }],
          stream: false
        };
      } else {
        // Fallback for OpenAI, Ark, DeepSeek, Minimax, etc.
        testUrl = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          model: modelName,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 5,
          stream: false
        };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const startTime = Date.now();
      try {
        const resp = await fetch(testUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const latency = Date.now() - startTime;
        if (resp.ok) {
          return res.json({ success: true, message: '模型有效连通', latency });
        } else {
          const errorText = await (await resp.blob()).text();
          let errMsg = `HTTP ${resp.status} ${resp.statusText}`;
          try {
            const parsed = JSON.parse(errorText);
            if (parsed.error?.message) errMsg += ` - ${parsed.error.message}`;
            else if (parsed.error) errMsg += ` - ${JSON.stringify(parsed.error)}`;
            else if (parsed.message) errMsg += ` - ${parsed.message}`;
          } catch {
            if (errorText.length > 0) errMsg += ` - ${errorText.substring(0, 100)}`;
          }
          return res.json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, errMsg));
        }
      } catch (e: any) {
        clearTimeout(timeoutId);
        return res.json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, e?.message || 'Network connection failed'));
      }
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_TEST_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.get('/api/models/discover', async (req, res) => {
    const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : '';
    if (!endpoint) {
      return res.status(400).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'endpoint required'));
    }
    const entry = providerEditor.readEntry(endpoint);
    if (!entry) {
      return res.status(404).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'Endpoint not found'));
    }
    // 加固过的探测：同源重定向、超时、响应上限；404/405 = 可达但没有目录。
    const probe = await probeProviderCatalog({ baseUrl: String(entry.baseUrl ?? ''), api: String(entry.api ?? 'openai-completions'), apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : null });
    if (!probe.ok) {
      return res.status(502).json(buildStructuredApiError(probe.errorCode, probe.detail, probe.status === null ? null : { status: probe.status }));
    }
    return res.json({ success: true, models: probe.models, catalogUnavailable: probe.catalogUnavailable });
  });

  app.post('/api/models/manage', requireAdminAuth, async (req, res) => {
    try {
      const { endpoint, modelName, alias, input } = req.body;
      if (!endpoint || !modelName) {
        return res.status(400).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, 'endpoint and modelName required'));
      }
      const success = await agentProvisioner.addModelConfig(endpoint, modelName, alias, Array.isArray(input) ? input : undefined);
      if (success) {
        // Gateway auto-reloads config files on change
        return res.json({ success: true });
      }
      return res.status(400).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, 'Model may already exist or config invalid'));
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_CREATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.delete('/api/models/manage', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, 'id required'));
      
      const success = await agentProvisioner.deleteModelConfig(id);
      if (success) {
        // Gateway auto-reloads config files on change
        return res.json({ success: true });
      }
      return res.status(404).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, 'Model not found'));
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_DELETE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.put('/api/models/manage/default', requireAdminAuth, async (req, res) => {
    try {
      const { id } = req.body;
      if (!id) return res.status(400).json({ success: false, error: 'id required' });

      const success = await agentProvisioner.setDefaultModel(id);
      if (success) {
        // Gateway auto-reloads config files on change
        return res.json({ success: true });
      }
      return res.status(404).json({ success: false, error: 'Model not found' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/models/manage', requireAdminAuth, async (req, res) => {
    try {
      const { id, alias, input } = req.body;
      if (!id) return res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'id required'));

      const success = await agentProvisioner.updateModelConfig(id, alias, Array.isArray(input) ? input : undefined);
      if (success) {
        return res.json({ success: true });
      }
      return res.status(404).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, 'Model not found'));
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.delete('/api/endpoints/manage', requireAdminAuth, async (req, res) => {
    try {
      const { endpoint } = req.body;
      if (!endpoint) return res.status(400).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'endpoint required'));

      const count = await agentProvisioner.deleteEndpointConfig(endpoint);
      providerAudit.record({ identity: getRequestIdentity(req), providerId: String(endpoint), action: 'provider.delete', result: count > 0 ? 'success' : 'failed', details: { deletedModels: count } });
      if (count > 0) {
        // Gateway auto-reloads config files on change
        return res.json({ success: true, deleted: count });
      }
      return res.status(404).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'Endpoint not found or no models under it'));
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, err?.message));
    }
  });
  app.get('/api/endpoints', (_req, res) => {
    try {
      // 凭据只出不进：不回 apiKey，只报 hasApiKey + 版本号（版本号对含 key 的完整条目求值）。
      const visible = new Set(agentProvisioner.getEndpoints().map((endpoint: { id: string }) => endpoint.id));
      const endpoints = providerEditor.list().filter((provider) => visible.has(provider.id));
      res.json({ success: true, endpoints });
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  app.post('/api/endpoints/test', requireAdminAuth, async (req, res) => {
    const { baseUrl, api } = req.body ?? {};
    if (!baseUrl || !api) {
      return res.status(400).json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, 'baseUrl and api are required'));
    }
    // 编辑已有服务商时前端拿不到 key：留空就用库里的，但只在测的还是同一个服务商时。
    const endpointId = typeof req.body?.endpointId === 'string' ? req.body.endpointId : '';
    const typedKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    const storedEntry = !typedKey && endpointId ? providerEditor.readEntry(endpointId) : null;
    const apiKey = typedKey || (typeof storedEntry?.apiKey === 'string' ? storedEntry.apiKey : '');
    const probe = await probeProviderCatalog({ baseUrl: String(baseUrl), api: String(api), apiKey });
    providerAudit.record({
      identity: getRequestIdentity(req),
      providerId: endpointId || 'draft',
      action: 'provider.test',
      result: probe.ok ? 'success' : 'failed',
      details: { baseUrl: String(baseUrl), api: String(api), errorCode: probe.ok ? null : probe.errorCode, catalogUnavailable: probe.ok ? probe.catalogUnavailable : null },
    });
    if (!probe.ok) {
      return res.json(buildStructuredApiError(probe.errorCode, probe.detail, probe.status === null ? null : { status: probe.status }));
    }
    return res.json({ success: true, catalogUnavailable: probe.catalogUnavailable, modelCount: probe.models.length });
  });

  app.post('/api/endpoints', requireAdminAuth, async (req, res) => {
    const { id, baseUrl, apiKey, api } = req.body ?? {};
    if (!id || !baseUrl || !api) {
      return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'id, baseUrl, and api are required'));
    }
    const identity = getRequestIdentity(req);
    try {
      const outcome = await providerEditor.save(id, { baseUrl, api, apiKey }, readRequestedRevision(req));
      providerAudit.record({ identity, providerId: String(id), action: outcome.created ? 'provider.create' : 'provider.update', result: 'success', fields: outcome.fields, revisionBefore: outcome.before, revisionAfter: outcome.after });
      return res.json({ success: true, revision: outcome.after });
    } catch (err: any) {
      if (err instanceof ProviderRevisionConflict) {
        providerAudit.record({ identity, providerId: String(id), action: 'provider.update', result: 'conflict' });
        return sendProviderConflict(res, err);
      }
      if (typeof err?.errorCode === 'string' && typeof err?.status === 'number') {
        return res.status(err.status).json(buildStructuredApiError(err.errorCode));
      }
      return res.status(500).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, err?.message));
    }
  });
}
