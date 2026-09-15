import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from '../_shared/cli-adapter';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import { CODEX_CAPABILITIES, CODEX_DESCRIPTOR, CODEX_GLOBAL_CREDENTIAL_ENV, CODEX_SOURCE_OF_TRUTH } from './definition';
import { createCodexDriver } from './driver';
import { prepareCodexLaunch } from './launch';

export { CODEX_CAPABILITIES, CODEX_DESCRIPTOR, CODEX_SOURCE_OF_TRUTH } from './definition';
export { codexToolView, findCodexSessionId } from './driver';
export { filterUserCodexConfig } from './launch';

export const CODEX_DEFINITION: RuntimeDefinition = {
  descriptor: CODEX_DESCRIPTOR,
  capabilities: CODEX_CAPABILITIES,
  sourceOfTruth: CODEX_SOURCE_OF_TRUTH,
  nativeSessionIds: 'observed',
  globalCredentialEnv: CODEX_GLOBAL_CREDENTIAL_ENV,
  supportsCommand: (kind) => kind === 'turn' || kind === 'compact',
  detectGatewayErrorText: true,
  prepare: prepareCodexLaunch,
  createDriver: createCodexDriver,
};

export function createCodexAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(CODEX_DEFINITION, deps);
}
