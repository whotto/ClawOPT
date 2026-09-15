export {
  resolveBinaryOnPath,
} from './binary-lookup';
export {
  CLAUDE_CODE_CAPABILITIES,
  CLAUDE_CODE_DESCRIPTOR,
  CLAUDE_CODE_SOURCE_OF_TRUTH,
  createClaudeCodeAdapter,
} from './adapters/claude-code';
export {
  createLocalProcessExecutor,
} from './adapters/_shared/process';
export type {
  ProcessExecutor,
} from './adapters/_shared/process';
export {
  RUNTIME_MESSAGE_CODES,
} from './adapters/_shared/errors';
export type {
  CodingAgentRuntimeAdapter,
} from './adapters/_shared/cli-adapter';
export type {
  AdapterLogger,
  CodingAgentAdapterDeps,
  CodingAgentRunRequest,
  ScopedProvider,
  ScopedProviderResolver,
} from './adapters/_shared/types';
export {
  CODING_AGENT_DEFINITIONS,
  codingAgentDefinition,
  registerCodingAgentAdapters,
} from './adapters/registry';
export {
  EXTERNAL_RUNTIMES,
  buildExternalRuntimeList,
} from './adapters/runtime-list';
export type {
  ExternalRuntimeDescriptor,
  ExternalRuntimeStatus,
} from './adapters/runtime-list';
export {
  OPENCLAW_ABORT_GRACE_MS,
  OPENCLAW_CAPABILITIES,
  createOpenClawRuntimeAdapter,
} from './adapters/openclaw';
export type {
  OpenClawChatRunRequest,
} from './adapters/openclaw';
export type {
  AdapterEvent,
  AdapterRunContext,
  AdapterRunHandle,
  AdapterRunOutcome,
  AgentRuntimeAdapter,
  CanonicalEvent,
  InterruptReason,
  ProxyMode,
  RuntimeCapabilities,
  SourceOfTruthTable,
  UsageReport,
} from './contract';
export {
  RunCoordinator,
} from './coordinator';
export type {
  AbortResult,
  BusyPolicy,
  ProjectorFinish,
  ProjectorRunContext,
  RunProjector,
  RunStore,
  RunSubmission,
  RunTerminal,
  RunView,
  SessionSnapshot,
  SubmitResult,
} from './coordinator';
export {
  registerExternalRuntimeRoutes,
} from './external-runtime-routes';
export {
  checkRuntimeInvariants,
} from './runtime-invariants';
// ---- P2-platform：本地模型代理 ----
export {
  API_MODES,
  ENCRYPTED_THINKING_PROBE_BYTES,
  LocalProviderProxy,
  PROXY_TARGET_RESTORE_MAX_AGE_MS,
  RUNTIME_PROXY_PREFIX,
  createProviderProxy,
  isApiMode,
  isOfficialAnthropicUpstream,
  requiresReasoningContentRoundTrip,
  resolveUpstreamEndpoint,
} from './proxy';
export type {
  ApiMode,
  CanonicalRuntimeEvent,
  LocalProviderProxyOptions,
  ProviderProxy,
  ProxyTarget,
  RegisteredProxyTarget,
} from './proxy';
export {
  RUNTIME_PROXY_BODY_LIMIT,
  registerRuntimeProxyBodyParser,
  registerRuntimeProxyRoutes,
} from './proxy/proxy-routes';
// ---- P2-platform：适配器登记、运行时管理器、MCP、远程 OpenClaw、底座组装 ----
export {
  RuntimeAdapterRegistry,
  registerAdapter,
  runtimeAdapterRegistry,
} from './adapter-registry';
export type {
  RegisteredRuntimeAdapter,
  RuntimeAdapterDeps,
  RuntimeAdapterFactory,
  RuntimeRunRequest,
} from './adapter-registry';
export { registerBuiltinAdapters } from './builtin-adapters';
export { sanitizeMemberExternalConfig } from './member-config';
export { createRuntimePlatform } from './platform';
export type { RuntimePlatform, RuntimePlatformOptions } from './platform';
export { registerRuntimePlatformRoutes } from './platform-routes';
export {
  BUILTIN_RUNTIME_DESCRIPTORS,
  CHILD_ENV_ALLOWLIST,
  LocalRuntimeManager,
  RuntimeHomes,
  RuntimeManagerError,
  createRuntimeManager,
  probeHostCapabilities,
  sanitizeProcessOutput,
} from './manager';
export type {
  HostCapabilities,
  RuntimeDescriptor,
  RuntimeHomeOwner,
  RuntimeManager,
  RuntimeStatus,
} from './manager';
export {
  createMcpInjector,
  isManagedMcpServer,
  shapeClaudeMcpConfig,
  shapeCodexMcpConfig,
  shapeDshMcpPatch,
  shapeGrokMcpConfig,
  shapeMcpConfig,
  shapeOpenCodeMcpConfig,
  shapePiMcpConfig,
} from './mcp';
export type { ManagedMcpServer, McpInjector } from './mcp';
export {
  REMOTE_OPENCLAW_CAPABILITIES,
  REMOTE_OPENCLAW_DESCRIPTOR,
  REMOTE_OPENCLAW_RUNTIME_ID,
  RemoteMemberSecretStore,
  createRemoteOpenClawRuntimeAdapter,
  testRemoteOpenClawConnection,
} from './remote-openclaw';
export {
  LocalSecretBox,
  constantTimeEquals,
  defaultRuntimeDataDir,
} from './platform-store';
export {
  NetPolicyError,
  assertOutboundUrlAllowed,
  isLocalProvider,
  isPrivateAddress,
} from './net-policy';
export type {
  InvariantMemberRow,
  InvariantSessionRow,
  InvariantSeverity,
  RuntimeInvariantDeps,
  RuntimeInvariantIssue,
} from './runtime-invariants';
