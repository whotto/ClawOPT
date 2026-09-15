/**
 * scoped 模式的上游解析：成员 / 单聊会话的外部运行时配置里只存 ClawOPT 模型配置里的模型 id（`<端点>/<模型>`），
 * 服务商地址、key、协议在服务端从 openclaw.json 的 `models.providers` 取——key 只交给本地代理（内存），
 * 永不出现在成员配置、会话行、CLI 配置文件或前端里。
 *
 * 放在 bootstrap：它把 control（模型配置）接给 runtime（适配器依赖），两个模块彼此不直接依赖。
 */
import type { AgentProvisioner } from '../control';
import { RuntimeAdapterError, type ScopedProvider, type ScopedProviderResolver } from '../runtime';

/** openclaw.json 里端点的 `api` → 代理的上游协议。 */
export function apiModeForEndpoint(api: string | undefined): ScopedProvider['apiMode'] {
  const value = String(api ?? '').toLowerCase();
  if (value.includes('anthropic')) return 'anthropic_messages';
  if (value.includes('responses')) return 'responses';
  return 'chat_completions';
}

export function createScopedProviderResolver(agentProvisioner: Pick<AgentProvisioner, 'readEndpointModel'>): ScopedProviderResolver {
  return (selection) => {
    const modelId = typeof selection?.model === 'string' ? selection.model.trim() : '';
    if (!modelId) return null;
    const snapshot = agentProvisioner.readEndpointModel(modelId);
    if (!snapshot || !snapshot.baseUrl) {
      throw new RuntimeAdapterError('runtime.providerCredentialsMissing', `model ${modelId} is not configured in ClawOPT models (endpoint missing)`);
    }
    const effort = typeof selection?.reasoningEffort === 'string' ? selection.reasoningEffort : undefined;
    return {
      provider: snapshot.endpointId,
      model: snapshot.modelName,
      baseUrl: snapshot.baseUrl,
      apiKey: snapshot.apiKey,
      apiMode: apiModeForEndpoint(snapshot.api),
      reasoningEffort: effort,
    };
  };
}
