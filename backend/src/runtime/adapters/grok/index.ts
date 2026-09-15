import { createCodingAgentAdapter, type CodingAgentRuntimeAdapter, type RuntimeDefinition } from '../_shared/cli-adapter';
import type { CodingAgentAdapterDeps } from '../_shared/types';
import { GROK_CAPABILITIES, GROK_DESCRIPTOR, GROK_GLOBAL_CREDENTIAL_ENV, GROK_SOURCE_OF_TRUTH } from './definition';
import { createGrokDriver } from './driver';
import { prepareGrokLaunch } from './launch';

export { GROK_CAPABILITIES, GROK_DESCRIPTOR, GROK_SOURCE_OF_TRUTH } from './definition';
export { grokSessionExists } from './launch';

export const GROK_DEFINITION: RuntimeDefinition = {
  descriptor: GROK_DESCRIPTOR,
  capabilities: GROK_CAPABILITIES,
  sourceOfTruth: GROK_SOURCE_OF_TRUTH,
  nativeSessionIds: 'client',
  globalCredentialEnv: GROK_GLOBAL_CREDENTIAL_ENV,
  supportsCommand: (kind) => kind === 'turn' || kind === 'compact',
  detectGatewayErrorText: true,
  prepare: prepareGrokLaunch,
  createDriver: createGrokDriver,
};

export function createGrokAdapter(deps: CodingAgentAdapterDeps): CodingAgentRuntimeAdapter {
  return createCodingAgentAdapter(GROK_DEFINITION, deps);
}
