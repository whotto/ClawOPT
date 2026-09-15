import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from '../_shared/cli-adapter';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DESCRIPTOR,
  CLAUDE_CODE_GLOBAL_CREDENTIAL_ENV,
  CLAUDE_CODE_SOURCE_OF_TRUTH,
} from './definition';
import { createClaudeCodeDriver } from './driver';
import { prepareClaudeCodeLaunch } from './launch';

export { CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_DESCRIPTOR, CLAUDE_CODE_SOURCE_OF_TRUTH } from './definition';
export { claudeMcpConfig, scrubInheritedClaudeSettings } from './launch';

export const CLAUDE_CODE_DEFINITION: RuntimeDefinition = {
  descriptor: CLAUDE_CODE_DESCRIPTOR,
  capabilities: CLAUDE_CODE_CAPABILITIES,
  sourceOfTruth: CLAUDE_CODE_SOURCE_OF_TRUTH,
  nativeSessionIds: 'client',
  globalCredentialEnv: CLAUDE_CODE_GLOBAL_CREDENTIAL_ENV,
  // status / usage 由宿主按记录的用量回答（CLI 没有原生命令）；compact 作为一轮发出。
  supportsCommand: (kind) => kind === 'turn' || kind === 'compact',
  detectGatewayErrorText: false,
  prepare: prepareClaudeCodeLaunch,
  createDriver: createClaudeCodeDriver,
};

export function createClaudeCodeAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(CLAUDE_CODE_DEFINITION, deps);
}
