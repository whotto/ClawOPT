import type {
  AgentRuntimeMode,
  AgentSystemPromptMode,
  AgentToolMode,
  SessionRow,
} from '../../core/db';
import { readMaxPermissionsEnabled } from '../gateway/max-permissions';
import { AgentProvisioner, ConfigReadError } from './agent-provisioner';

export function normalizeFallbackMode(value: unknown): 'inherit' | 'custom' | 'disabled' | undefined {
  return value === 'inherit' || value === 'custom' || value === 'disabled' ? value : undefined;
}

export function normalizeAgentRuntimeMode(value: unknown): AgentRuntimeMode {
  return value === 'direct' ? 'direct' : 'configured';
}

export function normalizeAgentSystemPromptMode(value: unknown): AgentSystemPromptMode {
  return value === 'agent' ? 'agent' : 'system';
}

export function normalizeAgentToolMode(value: unknown): AgentToolMode {
  if (value === 'coding' || value === 'messaging' || value === 'minimal' || value === 'off') {
    return value;
  }
  return 'full';
}

export function normalizeFallbackList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * 在「已经在报错」的路径里，给结构化错误消息挑一个 model 标签用——纯展示用途，
 * 不代表任何"成功"。`readAgentModel()` / `readAvailableModels()` 现在对配置读不动
 * 会抛 ConfigReadError（这正是本 sprint 要的：别把「读不动」伪装成「没有模型」），
 * 但这里已经在 catch 块里构建一条错误消息了——这个调用点自己再抛一次不会让用户
 * 看到更多信息，只会让本该发出的错误响应发不出去（这个 catch 块之外没人再兜底）。
 * 所以这里显式吞掉 ConfigReadError，退回到空字符串。
 */
export function resolveModelTagForErrorReport(agentProvisioner: AgentProvisioner, agentId: string): string {
  try {
    return agentProvisioner.readAgentModel(agentId)
      || agentProvisioner.readAvailableModels().find(m => m.primary)?.id
      || '';
  } catch (err) {
    if (err instanceof ConfigReadError) return '';
    throw err;
  }
}

/**
 * 纯展示型只读接口（GET /api/sessions、/api/characters、/api/sessions/:id/configs、
 * GET /api/models）不该因为"模型标签读不到"就整条 500——用户还是要能打开列表看到
 * 别的字段。同 `resolveModelTagForErrorReport()` 一样显式吞掉 ConfigReadError，
 * 退回调用方给的退化值，但额外报出 `configReadFailed`，让前端能分辨出
 * "这不是没配模型，是配置读不动"，不把两者混成一件事。
 */
export function withConfigReadFallback<T>(fallback: T, read: () => T): { value: T; configReadFailed: boolean } {
  try {
    return { value: read(), configReadFailed: false };
  } catch (err) {
    if (err instanceof ConfigReadError) return { value: fallback, configReadFailed: true };
    throw err;
  }
}

// `readAgentRuntimeConfig()`（`readEffectiveAgentRuntimeSettings()` 内部调它）在配置
// 损坏时也会抛 ConfigReadError——和 model 字段是同一类"读不动"，同样不该让这几个只读
// 接口整体 500。退化形状照抄它自己对"配置文件不存在"这个合法状态给出的默认值。
export const RUNTIME_SETTINGS_CONFIG_READ_FALLBACK = { systemPromptMode: 'system' as const, toolMode: 'full' as const };

export type AgentSettingsDeps = {
  agentProvisioner: AgentProvisioner;
};

export function createAgentSettings(ctx: AgentSettingsDeps) {
  const { agentProvisioner } = ctx;

  /**
   * 只读展示路径上取 agent 模型名：配置读不动时退回 `undefined`，**并出声**。
   *
   * 为什么需要它（Gemini 评审 CRITICAL，本机复现）：`readConfigFile()` 三态化之后
   * `readAgentModel()` 从「永不抛」变成「会抛」，而 `reconcileInactiveGroupLatestMessage()`
   * 里的两处调用是裸的，外层 `app.get('/api/groups/:id/messages')` 只有一个笼统的
   * `catch → 500`。净效果是**把一条本来能用的接口改坏了**：
   * 改动前 `null || undefined` 兜得住、群消息列表照常返回；改动后配置一坏，
   * 整个群的历史消息打不开。这比本 sprint 要修的原始 bug 更糟。
   *
   * 这里退回旧语义，但不静默——红线 C 管的是「失败要出声」，不是「失败必须致命」。
   * 模型名只是消息上的一个标签，为它牺牲整条历史是错误的取舍。
   */
  function readAgentModelForDisplay(agentId: string): string | undefined {
    try {
      return agentProvisioner.readAgentModel(agentId) || undefined;
    } catch (error) {
      if (!(error instanceof ConfigReadError)) throw error;
      console.warn(
        `[GroupMessages] 取模型名失败（${error.reason}），该条消息的模型标签留空：agentId=${agentId}`,
      );
      return undefined;
    }
  }

  function readEffectiveAgentRuntimeSettings(sessionInfo: SessionRow | undefined, agentId: string): {
    runtimeMode: AgentRuntimeMode;
    systemPromptMode: AgentSystemPromptMode;
    toolMode: AgentToolMode;
  } {
    const openClawRuntime = agentProvisioner.readAgentRuntimeConfig(agentId);
    return {
      runtimeMode: normalizeAgentRuntimeMode(sessionInfo?.runtime_mode),
      systemPromptMode: openClawRuntime.systemPromptMode,
      toolMode: openClawRuntime.toolMode,
    };
  }

  function shouldInjectHostTakeoverInstruction(sessionInfo: SessionRow | undefined, agentId: string): boolean {
    if (readMaxPermissionsEnabled() !== true) return false;
    const runtimeSettings = readEffectiveAgentRuntimeSettings(sessionInfo, agentId);
    if (runtimeSettings.runtimeMode === 'direct') return false;
    return runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding';
  }

  return {
    readAgentModelForDisplay,
    readEffectiveAgentRuntimeSettings,
    shouldInjectHostTakeoverInstruction,
  };
}
export type AgentSettings = ReturnType<typeof createAgentSettings>;
