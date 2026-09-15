import { createAcpDriver } from '../_shared/acp';
import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from '../_shared/cli-adapter';
import { managedPromptBlock } from '../_shared/managed-prompt';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import { DSH_CAPABILITIES, DSH_DESCRIPTOR, DSH_GLOBAL_CREDENTIAL_ENV, DSH_SOURCE_OF_TRUTH } from './definition';
import { DSH_PROVIDER_ID, dshEffort, prepareDshLaunch } from './launch';

export { DSH_CAPABILITIES, DSH_DESCRIPTOR, DSH_SOURCE_OF_TRUTH } from './definition';
export { dshEffort } from './launch';

export const DSH_DEFINITION: RuntimeDefinition = {
  descriptor: DSH_DESCRIPTOR,
  capabilities: DSH_CAPABILITIES,
  sourceOfTruth: DSH_SOURCE_OF_TRUTH,
  nativeSessionIds: 'observed',
  globalCredentialEnv: DSH_GLOBAL_CREDENTIAL_ENV,
  supportsCommand: (kind) => kind === 'turn',
  detectGatewayErrorText: true,
  prepare: prepareDshLaunch,
  createDriver: (ctx) => createAcpDriver(ctx, {
    label: 'DeepSeek Harness',
    permissions: 'auto-allow',
    // 实测：全新的 DSH_HOME 首次启动时 profile 边初始化边加载插件，session/new 会先回
    // `no adapter registered for provider "clawopt"`；同一进程里稍等再建就好。
    retrySessionNew: /no adapter registered for provider/i,
    promptBlocks: (turn) => {
      const blocks: unknown[] = [];
      // global 模式不改用户的 ~/.dsh：指令作为本轮第一个文本块。scoped 已写进运行时 home 的 AGENTS.md。
      const instructions = turn.mode === 'global' ? [turn.request.groupSystemPrompt || turn.request.systemPrompt, turn.request.instructions].filter(Boolean).join('\n\n') : '';
      if (instructions) blocks.push({ type: 'text', text: managedPromptBlock(instructions) });
      blocks.push({ type: 'text', text: turn.request.prompt });
      return blocks;
    },
    configure: async (peer, sessionId, _result, turn) => {
      if (turn.mode !== 'scoped' || !turn.request.provider) return;
      // 模型选项的取值是 JSON 数组字符串；--patch 已设默认路由，这里对续上的旧会话再显式选一次。
      await peer.request('session/set_config_option', { sessionId, configId: 'model', value: JSON.stringify([DSH_PROVIDER_ID, turn.request.provider.model]) });
      const effort = dshEffort(turn.request.provider.reasoningEffort ?? turn.request.reasoningEffort);
      if (effort) await peer.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: effort });
    },
  }),
};

export function createDshAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(DSH_DEFINITION, deps);
}
