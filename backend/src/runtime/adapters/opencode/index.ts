import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from '../_shared/cli-adapter';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import { OPENCODE_CAPABILITIES, OPENCODE_DESCRIPTOR, OPENCODE_GLOBAL_CREDENTIAL_ENV, OPENCODE_SOURCE_OF_TRUTH } from './definition';
import { createOpenCodeDriver } from './driver';
import { prepareOpenCodeLaunch } from './launch';

export { OPENCODE_CAPABILITIES, OPENCODE_DESCRIPTOR, OPENCODE_SOURCE_OF_TRUTH } from './definition';
export { opencodeMcpConfig } from './launch';

export const OPENCODE_DEFINITION: RuntimeDefinition = {
  descriptor: OPENCODE_DESCRIPTOR,
  capabilities: OPENCODE_CAPABILITIES,
  sourceOfTruth: OPENCODE_SOURCE_OF_TRUTH,
  nativeSessionIds: 'observed',
  globalCredentialEnv: OPENCODE_GLOBAL_CREDENTIAL_ENV,
  // /compact 只在 TUI 里有；压缩由 OpenCode 自己的自动压缩负责。
  supportsCommand: (kind) => kind === 'turn',
  detectGatewayErrorText: true,
  prepare: prepareOpenCodeLaunch,
  createDriver: createOpenCodeDriver,
};

export function createOpenCodeAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(OPENCODE_DEFINITION, deps);
}
