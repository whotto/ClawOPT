/**
 * 克隆 Agent：复制人格与技能、不复制身份绑定与凭据，并**如实报告剥离了什么**。
 *
 * 复用 `.clawpack` 的导出组装（`buildAgentEntry`）与落盘（`writeAgentFiles`）——
 * 「克隆」与「导出再导入」是同一件事，两条路各拼一次迟早会出现一边带了凭据、一边没带。
 *
 * 剥离清单（spec 05 F20 的 OpenClaw 版）：
 * - **频道路由绑定**：`agents bindings` 里指向源 Agent 的绑定一条都不复制。频道机器人是独占身份，
 *   两个 Agent 绑同一个账号，网关只会让其中一个收到消息；
 * - **凭据文件**：包组装阶段就跳过（auth-profiles.json、.env、密钥形状的文件），残留扫描命中的文件也列出来；
 * - **私人数据**：MEMORY.md、memory/ 日志、对话历史不复制——克隆出来的是同一个角色的新实例，不是同一段记忆。
 *
 * 模型凭据沿用新建 Agent 的既有行为（从 main 继承 auth-profiles），不因克隆额外复制源 Agent 的凭据。
 */
import type { SessionManager } from '../../collab/sessions';
import { AGENT_ID_ALREADY_EXISTS_ERROR_CODE } from '../../core/http';
import type { OpenClawCliRunner } from '../../openclaw';
import { buildAgentEntry, writeAgentFiles, type PackWarning } from '../packs/agent-pack';
import { AGENT_ID_PATTERN, ControlInputError, optionalString, requireString } from '../shared/control-http';
import type { AgentAvatarStore } from './agent-avatar-store';
import type { AgentProvisioner } from './agent-provisioner';
import type { AgentSettings } from './agent-settings';

export type CloneReport = {
  copiedFiles: string[];
  strippedBindings: Array<{ channel: string | null; accountId: string | null }> | null;
  skippedPrivate: string[];
  credentialWarnings: string[];
  avatarCopied: boolean;
};

export function normalizeBindings(raw: unknown): Array<{ channel: string | null; accountId: string | null }> {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { bindings?: unknown })?.bindings) ? (raw as { bindings: unknown[] }).bindings : [];
  return list.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object').map((entry) => {
    const match = (entry.match && typeof entry.match === 'object' ? entry.match : entry) as Record<string, unknown>;
    return {
      channel: typeof match.channel === 'string' ? match.channel : null,
      accountId: typeof match.accountId === 'string' ? match.accountId : null,
    };
  });
}

export type AgentCloneDeps = {
  agentProvisioner: AgentProvisioner;
  sessionManager: SessionManager;
  agentSettings: AgentSettings;
  openclawCli: OpenClawCliRunner;
  avatars: AgentAvatarStore;
};

export function createAgentCloneService(deps: AgentCloneDeps) {
  const { agentProvisioner, sessionManager, agentSettings } = deps;

  async function clone(sourceIdRaw: unknown, input: { newAgentId?: unknown; name?: unknown }): Promise<{ session: unknown; report: CloneReport }> {
    const sourceId = requireString(sourceIdRaw, 'agents.idRequired', { pattern: AGENT_ID_PATTERN });
    const newId = requireString(input?.newAgentId, 'agents.idRequired', { pattern: AGENT_ID_PATTERN });
    const source = sessionManager.getSession(sourceId);
    if (!source) throw new ControlInputError('packs.agentNotFound', 404, { agentId: sourceId });
    if (sessionManager.getSession(newId)) throw new ControlInputError(AGENT_ID_ALREADY_EXISTS_ERROR_CODE, 409, { agentId: newId });
    const name = optionalString(input.name, 'agents.invalidName', { max: 60 }) ?? `${source.name} (copy)`;

    const warnings: PackWarning[] = [];
    const entry = buildAgentEntry(sourceId, source.name, agentProvisioner.getWorkspacePath(sourceId), { includeMemory: false, includeAutomations: false }, warnings);
    const runtime = agentSettings.readEffectiveAgentRuntimeSettings(source, sourceId);
    const modelConfig = agentProvisioner.readAgentModelConfig(sourceId);

    let strippedBindings: CloneReport['strippedBindings'] = null;
    try {
      strippedBindings = normalizeBindings(await deps.openclawCli.runJson(['agents', 'bindings', '--agent', sourceId, '--json']));
    } catch {
      // 读不到绑定就如实报 null（未知），不假装「没有绑定」。克隆本身从不复制绑定。
    }

    const session = sessionManager.createSession({
      id: newId,
      name,
      agentId: newId,
      process_start_tag: source.process_start_tag,
      process_end_tag: source.process_end_tag,
      runtime_mode: runtime.runtimeMode,
      system_prompt_mode: runtime.systemPromptMode,
      tool_mode: runtime.toolMode,
    });
    try {
      await agentProvisioner.provision({
        agentId: newId,
        preserveWorkspaceFiles: true,
        model: modelConfig.modelOverride ?? undefined,
        fallbackMode: modelConfig.fallbackMode,
        fallbacks: modelConfig.fallbacks,
        systemPromptMode: runtime.systemPromptMode,
        toolMode: runtime.toolMode,
      });
      writeAgentFiles(entry, agentProvisioner.getWorkspacePath(newId));
    } catch (error) {
      sessionManager.deleteSession(newId);
      throw error;
    }

    const avatarCopied = deps.avatars.copy(sourceId, newId);
    return {
      session,
      report: {
        copiedFiles: entry.files.map((file) => file.path).sort(),
        strippedBindings,
        skippedPrivate: ['MEMORY.md', 'memory/', 'sessions'],
        credentialWarnings: warnings.filter((warning) => warning.code.startsWith('credential.')).map((warning) => warning.detail ?? warning.code),
        avatarCopied,
      },
    };
  }

  return { clone };
}

export type AgentCloneService = ReturnType<typeof createAgentCloneService>;
