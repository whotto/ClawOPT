/**
 * scoped 模式的上游解析：成员 / 会话配置里只有模型 id，地址、key、协议在服务端从 ClawOPT 的模型配置取。
 */
import { describe, expect, it } from 'vitest';
import { apiModeForEndpoint, createScopedProviderResolver } from '../src/bootstrap/scoped-provider-resolver';

const snapshot = (api: string) => ({ id: 'deepseek/deepseek-v4', endpointId: 'deepseek', modelName: 'deepseek-v4', baseUrl: 'https://api.deepseek.example/v1', apiKey: 'sk-upstream', api });

describe('scoped 上游解析', () => {
  it('端点 api → 代理协议', () => {
    expect(apiModeForEndpoint('openai-completions')).toBe('chat_completions');
    expect(apiModeForEndpoint('openai-responses')).toBe('responses');
    expect(apiModeForEndpoint('anthropic-messages')).toBe('anthropic_messages');
    expect(apiModeForEndpoint(undefined)).toBe('chat_completions');
  });

  it('按模型 id 取端点：服务商、模型名、地址、key、协议、推理强度', () => {
    const resolve = createScopedProviderResolver({ readEndpointModel: (id: string) => (id === 'deepseek/deepseek-v4' ? snapshot('anthropic-messages') : null) } as any);
    expect(resolve({ model: 'deepseek/deepseek-v4', reasoningEffort: 'high' }, 'claude-code')).toEqual({
      provider: 'deepseek', model: 'deepseek-v4', baseUrl: 'https://api.deepseek.example/v1', apiKey: 'sk-upstream', apiMode: 'anthropic_messages', reasoningEffort: 'high',
    });
  });

  it('没选模型返回 null（适配器报 runtime.modelRequired）；模型不在配置里报 runtime.providerCredentialsMissing', () => {
    const resolve = createScopedProviderResolver({ readEndpointModel: () => null } as any);
    expect(resolve({}, 'codex')).toBeNull();
    expect(() => resolve({ model: 'ghost/model' }, 'codex')).toThrow(expect.objectContaining({ messageCode: 'runtime.providerCredentialsMissing' }));
  });
});
