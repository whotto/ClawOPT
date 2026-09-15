import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from '../_shared/cli-adapter';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import { PI_CAPABILITIES, PI_DESCRIPTOR, PI_GLOBAL_CREDENTIAL_ENV, PI_SOURCE_OF_TRUTH } from './definition';
import { createPiDriver } from './driver';
import { preparePiLaunch } from './launch';

export { PI_CAPABILITIES, PI_DESCRIPTOR, PI_SOURCE_OF_TRUTH } from './definition';
export { piThinkingLevel } from './launch';

export const PI_DEFINITION: RuntimeDefinition = {
  descriptor: PI_DESCRIPTOR,
  capabilities: PI_CAPABILITIES,
  sourceOfTruth: PI_SOURCE_OF_TRUTH,
  nativeSessionIds: 'client',
  globalCredentialEnv: PI_GLOBAL_CREDENTIAL_ENV,
  // Pi 有原生的 get_state / get_session_stats / compact。
  supportsCommand: () => true,
  detectGatewayErrorText: true,
  prepare: preparePiLaunch,
  createDriver: createPiDriver,
};

export function createPiAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(PI_DEFINITION, deps);
}
