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
  type RouteApp,
} from '../../core/http';
import type { AgentProvisioner } from '../agents/agent-provisioner';
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
};

export function registerModelRoutes(app: RouteApp, ctx: ModelRoutesDeps): void {
  const { agentProvisioner } = ctx;
  const { readOpenClawImageProviderSnapshot } = ctx.imageGeneration;

  app.get('/api/models', (_req, res) => {
    // 配置读不动时退回空列表的旧降级行为，不让这条首屏必调的接口整体 500。
    const { value: models, configReadFailed } = withConfigReadFallback(
      [] as ReturnType<typeof agentProvisioner.readAvailableModels>,
      () => agentProvisioner.readAvailableModels(),
    );
    res.json({ success: true, models, configReadFailed });
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

  app.put('/api/models/fallbacks', async (req, res) => {
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

  app.put('/api/models/image-generation', async (req, res) => {
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

  app.post('/api/models/test-image-generation', async (req, res) => {
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

  app.post('/api/models/test', async (req, res) => {
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
        testUrl = `${baseUrl.replace(/\/$/, '')}/models/${modelName}:generateContent?key=${apiKey}`;
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
    try {
      const endpoint = req.query.endpoint as string;
      if (!endpoint) {
        return res.status(400).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'endpoint required'));
      }

      const endpoints = agentProvisioner.getEndpoints();
      const config = endpoints.find((e: any) => e.id === endpoint);
      if (!config) {
        return res.status(404).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, 'Endpoint not found'));
      }

      const baseUrl = config.baseUrl.replace(/\/$/, '');
      const apiKey = config.apiKey || '';
      const apiType = config.api.toLowerCase();

      let discoverUrl = '';
      const headers: any = {
        'Content-Type': 'application/json'
      };

      if (apiType.includes('anthropic')) {
        discoverUrl = `${baseUrl}/models`;
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (apiType.includes('gemini') || apiType.includes('google')) {
        discoverUrl = `${baseUrl}/models?key=${apiKey}`;
      } else if (apiType.includes('ollama')) {
        discoverUrl = `${baseUrl}/api/tags`;
      } else {
        // Fallback for OpenAI, Ark, DeepSeek, Minimax, etc.
        discoverUrl = `${baseUrl}/models`;
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(discoverUrl, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errorText = await resp.text();
        return res.status(resp.status).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, `Failed to discover models: HTTP ${resp.status} - ${errorText.substring(0, 100)}`));
      }

      const data: any = await resp.json();
      let models: string[] = [];

      if (apiType.includes('ollama')) {
        if (data.models && Array.isArray(data.models)) {
          models = data.models.map((m: any) => m.name);
        }
      } else if (apiType.includes('gemini') || apiType.includes('google')) {
        if (data.models && Array.isArray(data.models)) {
          models = data.models.map((m: any) => m.name.replace('models/', ''));
        }
      } else {
        // OpenAI / Anthropic format
        if (data.data && Array.isArray(data.data)) {
          models = data.data.map((m: any) => m.id);
        } else if (Array.isArray(data)) {
           models = data.map((m: any) => m.id || m.name);
        }
      }

      return res.json({ success: true, models: models.filter(Boolean) });
    } catch (err: any) {
      return res.status(500).json(buildStructuredApiError(MODEL_DISCOVER_FAILED_ERROR_CODE, err?.message || 'Network error during discovery'));
    }
  });

  app.post('/api/models/manage', async (req, res) => {
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

  app.delete('/api/models/manage', async (req, res) => {
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

  app.put('/api/models/manage/default', async (req, res) => {
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

  app.put('/api/models/manage', async (req, res) => {
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

  app.delete('/api/endpoints/manage', async (req, res) => {
    try {
      const { endpoint } = req.body;
      if (!endpoint) return res.status(400).json(buildStructuredApiError(ENDPOINT_DELETE_FAILED_ERROR_CODE, 'endpoint required'));

      const count = await agentProvisioner.deleteEndpointConfig(endpoint);
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
      const endpoints = agentProvisioner.getEndpoints();
      res.json({ success: true, endpoints });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/endpoints/test', async (req, res) => {
    try {
      const { baseUrl, apiKey, api } = req.body;
      if (!baseUrl || !api) {
        return res.status(400).json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, 'baseUrl and api are required'));
      }

      const cleanBaseUrl = baseUrl.replace(/\/$/, '');
      const apiType = api.toLowerCase();

      let discoverUrl = '';
      const headers: any = {
        'Content-Type': 'application/json'
      };

      if (apiType.includes('anthropic')) {
        discoverUrl = `${cleanBaseUrl}/models`;
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (apiType.includes('gemini') || apiType.includes('google')) {
        discoverUrl = `${cleanBaseUrl}/models?key=${apiKey}`;
      } else if (apiType.includes('ollama')) {
        discoverUrl = `${cleanBaseUrl}/api/tags`;
      } else {
        discoverUrl = `${cleanBaseUrl}/models`;
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(discoverUrl, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
          return res.json({ success: true });
      } else {
          const errText = await resp.text();
          return res.json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, `Status ${resp.status}: ${errText.substring(0, 100)}`));
      }
    } catch (err: any) {
      return res.json(buildStructuredApiError(ENDPOINT_TEST_FAILED_ERROR_CODE, err?.message || 'Connection failed'));
    }
  });

  app.post('/api/endpoints', async (req, res) => {
    try {
      const { id, baseUrl, apiKey, api } = req.body;
      if (!id || !baseUrl || !api) {
        return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'id, baseUrl, and api are required'));
      }

      const success = await agentProvisioner.saveEndpoint(id, { baseUrl, apiKey, api });
      if (success) {
        // Gateway auto-reloads config files on change
        return res.json({ success: true });
      }
      return res.status(400).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, 'Failed to save endpoint'));
    } catch (err: any) {
      res.status(500).json(buildStructuredApiError(ENDPOINT_CREATE_FAILED_ERROR_CODE, err?.message));
    }
  });
}
