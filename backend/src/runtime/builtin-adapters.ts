/**
 * 本分支自带的两个外部运行时登记：Claude Code（P1a 已迁到协调器）与远程 OpenClaw 成员。
 * 其余运行时（codex / pi / grok / opencode / dsh / hermes）由各自的适配器文件夹登记（P2 适配器分支）。
 */
import { createClaudeCodeRuntimeAdapter } from './adapters/claude-code';
import { runtimeAdapterRegistry, type RuntimeAdapterRegistry } from './adapter-registry';
import { BUILTIN_RUNTIME_DESCRIPTORS } from './manager/descriptors';
import { createRemoteOpenClawRuntimeAdapter, REMOTE_OPENCLAW_DESCRIPTOR } from './remote-openclaw';

export function registerBuiltinAdapters(registry: RuntimeAdapterRegistry = runtimeAdapterRegistry): void {
  if (!registry.get('claude-code')) {
    const descriptor = BUILTIN_RUNTIME_DESCRIPTORS.find((d) => d.id === 'claude-code')!;
    registry.registerAdapter(descriptor, (deps) => createClaudeCodeRuntimeAdapter({ executor: deps.executor }));
  }
  if (!registry.get(REMOTE_OPENCLAW_DESCRIPTOR.id)) {
    registry.registerAdapter(REMOTE_OPENCLAW_DESCRIPTOR, (deps) => {
      if (!deps.remoteOpenClawSecrets) throw new Error('remote-openclaw adapter needs the member secret store');
      return createRemoteOpenClawRuntimeAdapter({ secrets: deps.remoteOpenClawSecrets });
    });
  }
}
