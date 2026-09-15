/**
 * 内置的外部运行时登记：七个编码类运行时（Claude Code / Codex / Pi / Grok / OpenCode / DSH / Hermes，
 * 各自在 `adapters/<运行时>/`）与远程 OpenClaw 成员。
 */
import { runtimeAdapterRegistry, type RuntimeAdapterRegistry } from './adapter-registry';
import { registerCodingAgentAdapters } from './adapters/registry';
import { createRemoteOpenClawRuntimeAdapter, REMOTE_OPENCLAW_CAPABILITIES, REMOTE_OPENCLAW_DESCRIPTOR } from './remote-openclaw';

export function registerBuiltinAdapters(registry: RuntimeAdapterRegistry = runtimeAdapterRegistry): void {
  registerCodingAgentAdapters(registry);
  if (!registry.get(REMOTE_OPENCLAW_DESCRIPTOR.id)) {
    registry.registerAdapter(REMOTE_OPENCLAW_DESCRIPTOR, (deps) => {
      if (!deps.remoteOpenClawSecrets) throw new Error('remote-openclaw adapter needs the member secret store');
      return createRemoteOpenClawRuntimeAdapter({ secrets: deps.remoteOpenClawSecrets });
    }, { capabilities: REMOTE_OPENCLAW_CAPABILITIES });
  }
}
