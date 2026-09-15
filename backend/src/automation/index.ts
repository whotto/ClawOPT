export {
  createAutomation,
  isFakeRunnerEnabled,
} from './create-automation';
export type {
  Automation,
  AutomationDeps,
} from './create-automation';
export {
  registerAutomationRoutes,
  WEBHOOK_TEST_RECEIVER_PUBLIC_PATH,
  WORKFLOW_HOOK_PUBLIC_PATH,
} from './automation-routes';
export type {
  AutomationRoutesDeps,
} from './automation-routes';
export {
  registerWorkflowRoutes,
} from './workflow-routes';
export type {
  WorkflowRoutesDeps,
} from './workflow-routes';
export type {
  AgentRunRequest,
  AgentRunResult,
  ContentBlock,
  ContentBlocks,
  WorkflowAgentRef,
  WorkflowAgentRunner,
} from './ports';
export {
  buildEnvelope,
  parseEnvelope,
  remapDefinitionIds,
  WORKFLOW_ENVELOPE_FORMAT,
} from './workflow/portability';
export type {
  WorkflowEnvelope,
} from './workflow/portability';
