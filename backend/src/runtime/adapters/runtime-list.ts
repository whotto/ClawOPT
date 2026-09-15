/**
 * 外部运行时清单：界面据此决定「这台主机上能不能选某个运行时」。
 *
 * `id` 与 `group_members.runtime` 存的是**同一套取值**，清单从适配器登记表派生，不另写一份。
 * 两套取值迟早分家——界面写 `claude_code`、库里存 `claude-code`，而分家的症状是「选了但不生效」，
 * 本仓库正为这个形状栽过（v1.3.0：选了 Claude Code，回话的是 DeepSeek，无报错）。
 */
import type { ProxyMode, RuntimeCapabilities } from '../contract';
import { CODING_AGENT_DEFINITIONS } from './registry';

export interface ExternalRuntimeDescriptor {
  id: string;
  /** 需要主机上有哪个可执行文件。 */
  binary: string;
  /** 可读名，界面直接用，不必自己拼。 */
  label: string;
  /** 在真机上跑通过首轮 + 续话（见 docs/planning 的 P2 报告）。 */
  verified: boolean;
  installKind: 'npm' | 'pip' | 'manual';
  package?: string;
  modes: readonly ProxyMode[];
  capabilities: Readonly<RuntimeCapabilities>;
}

/** 真机验证过首轮与续话的运行时（P2，2026-09-15，本机 global 模式）。 */
const VERIFIED_RUNTIMES = new Set(['claude-code', 'codex', 'pi']);

export const EXTERNAL_RUNTIMES: readonly ExternalRuntimeDescriptor[] = CODING_AGENT_DEFINITIONS.map((definition) => ({
  id: definition.descriptor.id,
  binary: definition.descriptor.command,
  label: definition.descriptor.name,
  verified: VERIFIED_RUNTIMES.has(definition.descriptor.id),
  installKind: definition.descriptor.installKind,
  package: definition.descriptor.npmPackage ?? definition.descriptor.pipPackage,
  modes: definition.capabilities.proxyMode,
  capabilities: definition.capabilities,
}));

export interface ExternalRuntimeStatus extends ExternalRuntimeDescriptor {
  available: boolean;
  /**
   * 这次探测发生的时刻。探测结果有半衰期：外部 CLI 会自己升级、被卸载、被换路径。
   * 界面可以据此显示「检测于 X 分钟前 · 重新检测」，而不是把一个可能已经过期的结论当成事实摆着。
   */
  probedAt: string;
}

/**
 * 探测器由调用方注入（生产里是沿 PATH 找文件那一个）。**不 shell out**：
 * 起进程的成败取决于谁的 PATH 在前，而我们要问的只是「这个文件在不在」。
 */
export function buildExternalRuntimeList(binaryExists: (binary: string) => boolean): ExternalRuntimeStatus[] {
  const probedAt = new Date().toISOString();
  return EXTERNAL_RUNTIMES.map((runtime) => {
    let available = false;
    try {
      available = binaryExists(runtime.binary);
    } catch {
      // 某个 PATH 目录不可读，不该让「有哪些运行时」这个问题变成 500。
      available = false;
    }
    return { ...runtime, available, probedAt };
  });
}
