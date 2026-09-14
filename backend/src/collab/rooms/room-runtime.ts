import path from 'path';
import os from 'os';
import fs from 'fs';

import { type AgentProvisioner, readAgentBootstrapContextFromWorkspace } from '../../control';
import {
  ConfigReadError,
  type GatewayConnections,
  listRosterEntries,
  readOpenClawConfigSafe,
  resolveRosterShape,
} from '../../openclaw';
import { runtimeAgentSessionsNeedWorkspaceReset, type SessionRuntime } from '../sessions';
import {
  ensureGroupWorkspace,
  getAgentMemoryDbPath,
  getAgentStatePath,
  getGroupRuntimeAgentId,
  getGroupRuntimeAgentPrefix,
  getGroupWorkspacePath,
  getLegacyGroupRuntimeAgentId,
  getSharedGroupRuntimeAgentId,
  removeGroupWorkspaceBootstrapFiles,
} from './group-workspace';

export function createNextGroupRuntimeSessionEpoch(previousEpoch?: number | null): number {
  const current = Date.now();
  const normalizedPrevious = Number.isFinite(previousEpoch as number) ? Math.floor(Number(previousEpoch)) : 0;
  return current > normalizedPrevious ? current : normalizedPrevious + 1;
}

export function getGroupRuntimeContext(groupId: string, sourceAgentId: string): {
  runtimeAgentId: string;
  workspacePath: string;
  uploadsPath: string;
  outputPath: string;
} {
  const { workspacePath, uploadsPath, outputPath } = ensureGroupWorkspace(groupId);
  return {
    runtimeAgentId: getGroupRuntimeAgentId(groupId, sourceAgentId),
    workspacePath,
    uploadsPath,
    outputPath,
  };
}

function collectGroupRuntimeAgentIds(groupId: string): string[] {
  const collected = new Set<string>([
    getLegacyGroupRuntimeAgentId(groupId),
    getSharedGroupRuntimeAgentId(groupId),
  ]);

  const runtimeAgentPrefix = getGroupRuntimeAgentPrefix(groupId);
  const openClawRoot = path.join(os.homedir(), '.openclaw');
  const agentStateRoot = path.join(openClawRoot, 'agents');
  if (fs.existsSync(agentStateRoot)) {
    for (const entry of fs.readdirSync(agentStateRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(runtimeAgentPrefix)) {
        collected.add(entry.name);
      }
    }
  }

  const memoryRoot = path.join(openClawRoot, 'memory');
  if (fs.existsSync(memoryRoot)) {
    for (const entry of fs.readdirSync(memoryRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue;
      const agentId = entry.name.slice(0, -'.sqlite'.length);
      if (agentId.startsWith(runtimeAgentPrefix)) {
        collected.add(agentId);
      }
    }
  }

  const configPath = path.join(openClawRoot, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = readOpenClawConfigSafe() ?? {};
      // 走门面：契约只说了「agent-provisioner.ts 里现有四处」，按那句话永远找不到这一处。
      // 2.x 上旧写法返回空集，于是删群/重置群时**不清理任何运行时 agent**，
      // 工作区与配置条目全部残留。
      const rosterShape = resolveRosterShape(config as Record<string, unknown>).shape;
      const agentList = listRosterEntries(config as Record<string, unknown>, rosterShape);
      for (const entry of agentList) {
        if (typeof entry?.id === 'string' && entry.id.startsWith(runtimeAgentPrefix)) {
          collected.add(entry.id);
        }
      }
    } catch (error) {
      console.warn(`[GroupRuntime] Failed to read openclaw.json while collecting runtime agents for group ${groupId}:`, error);
    }
  }

  return Array.from(collected);
}

export type RoomRuntimeDeps = {
  agentProvisioner: AgentProvisioner;
  sessionRuntime: SessionRuntime;
  gatewayConnections: GatewayConnections;
};

export function createRoomRuntime(ctx: RoomRuntimeDeps) {
  const { agentProvisioner } = ctx;
  const { resetRuntimeAgentSessions } = ctx.sessionRuntime;
  const { disconnectConnection, waitForGatewayToSeeAgent } = ctx.gatewayConnections;

  function removeAgentRuntimeState(agentId: string): void {
    disconnectConnection(agentId);

    const agentStatePath = getAgentStatePath(agentId);
    if (fs.existsSync(agentStatePath)) {
      fs.rmSync(agentStatePath, { recursive: true, force: true });
    }

    const memoryDbPath = getAgentMemoryDbPath(agentId);
    if (fs.existsSync(memoryDbPath)) {
      fs.rmSync(memoryDbPath, { force: true });
    }
  }

  function cleanupLegacyGroupRuntimeArtifacts(groupId: string): void {
    const groupWorkspacePath = getGroupWorkspacePath(groupId);
    const legacyRuntimeAgentIds = [
      getLegacyGroupRuntimeAgentId(groupId),
      getSharedGroupRuntimeAgentId(groupId),
    ];

    for (const legacyRuntimeAgentId of legacyRuntimeAgentIds) {
      removeAgentRuntimeState(legacyRuntimeAgentId);
      agentProvisioner.removeConfigEntry(legacyRuntimeAgentId);

      const legacyWorkspacePath = agentProvisioner.getWorkspacePath(legacyRuntimeAgentId);
      if (legacyWorkspacePath !== groupWorkspacePath && fs.existsSync(legacyWorkspacePath)) {
        fs.rmSync(legacyWorkspacePath, { recursive: true, force: true });
      }
    }
  }

  /**
   * 清理一个群的运行时 Agent。
   *
   * 返回**清理没能完成的 agentId**——注意措辞：不是「配置里还留着条目」。
   *
   * 这个区别是对抗测试第四轮挑出来的，而且它两个方向都错过：
   * 配置读不动时，我们**根本无法知道**里面到底有没有这个条目——
   * 可能压根没写进去过（那就没有残留），也可能确实留着。
   * 上一版把「清理失败」当成「有残留」上报，等于把一件不知道的事说成了知道。
   *
   * 反方向同样：`removeConfigEntry()` 在「条目本来就不存在」时返回 false 而不抛，
   * 那不是失败，不该进这个列表。
   *
   * 所以这里只报**我们确实知道的那件事**：这几个 agentId 的配置清理没跑完，
   * 需要人去看一眼。调用方的文案也要照这个措辞，不能写成「配置里还留着」。
   *
   * 为什么不让它抛：`removeConfigEntry()` 现在会对「配置读不动」抛 ConfigReadError
   * （这是对的，删除报成功而一个字节没删是红线 C 禁止的形状）。但如果让它在这里
   * 直接往上冒，循环后面的工作区删除、以及调用方的 `db.deleteGroupChat()` 全都
   * 不会执行——用户想删一个群，结果因为配置文件坏了，群、工作区、数据库行**一样都没删掉**，
   * 只拿到一个 500。这是把「配置读不动」升级成了「群删不掉」。
   *
   * 与 `readAgentModelForDisplay()` 同一个取舍：外围失败不该杀掉主操作，但必须出声。
   */
  function cleanupGroupRuntimeAgent(groupId: string, options: { removeConfig?: boolean } = {}): string[] {
    const configCleanupFailed: string[] = [];
    for (const runtimeAgentId of collectGroupRuntimeAgentIds(groupId)) {
      removeAgentRuntimeState(runtimeAgentId);
      if (options.removeConfig) {
        try {
          agentProvisioner.removeConfigEntry(runtimeAgentId);
        } catch (error) {
          if (!(error instanceof ConfigReadError)) throw error;
          configCleanupFailed.push(runtimeAgentId);
          console.error(
            `[cleanupGroupRuntimeAgent] 无法从 openclaw.json 清除运行时 Agent（${error.reason}：${error.detail}）：${runtimeAgentId}`,
          );
        }
      }

      const runtimeWorkspacePath = agentProvisioner.getWorkspacePath(runtimeAgentId);
      if (fs.existsSync(runtimeWorkspacePath)) {
        fs.rmSync(runtimeWorkspacePath, { recursive: true, force: true });
      }
    }

    return configCleanupFailed;
  }

  async function prepareGroupRuntimeAgent(groupId: string, sourceAgentId: string): Promise<{
    runtimeAgentId: string;
    workspacePath: string;
    uploadsPath: string;
    outputPath: string;
    bootstrapContext: string;
  }> {
    const { workspacePath, uploadsPath, outputPath } = ensureGroupWorkspace(groupId);
    const runtimeAgentId = getGroupRuntimeAgentId(groupId, sourceAgentId);
    const runtimeWorkspacePath = agentProvisioner.getWorkspacePath(sourceAgentId);
    const sourceModelConfig = agentProvisioner.readAgentModelConfig(sourceAgentId);
    const sourceRuntimeConfig = agentProvisioner.readAgentRuntimeConfig(sourceAgentId);

    cleanupLegacyGroupRuntimeArtifacts(groupId);
    removeGroupWorkspaceBootstrapFiles(groupId);

    if (runtimeAgentSessionsNeedWorkspaceReset(runtimeAgentId, runtimeWorkspacePath)) {
      resetRuntimeAgentSessions(runtimeAgentId);
    }

    // 克隆体的工作区就是源 Agent 的目录，里面的 SOUL/USER/... 本来就是源 Agent 的，
    // 不再「读出来再写回去」：源 Agent 缺哪个文件，原来这里就会在它的工作区里
    // 生成一个空的同名文件（readAgentFile 缺省返回 ''，而 '' !== undefined 会触发写入）。
    await agentProvisioner.provision({
      agentId: runtimeAgentId,
      workspaceDir: runtimeWorkspacePath,
      preserveWorkspaceFiles: true,
      model: sourceModelConfig.modelOverride || undefined,
      fallbackMode: sourceModelConfig.fallbackMode,
      fallbacks: sourceModelConfig.fallbacks,
      systemPromptMode: sourceRuntimeConfig.systemPromptMode,
      toolMode: sourceRuntimeConfig.toolMode,
    });

    await waitForGatewayToSeeAgent(runtimeAgentId);

    return {
      runtimeAgentId,
      workspacePath,
      uploadsPath,
      outputPath,
      bootstrapContext: readAgentBootstrapContextFromWorkspace(runtimeWorkspacePath),
    };
  }

  return {
    cleanupLegacyGroupRuntimeArtifacts,
    cleanupGroupRuntimeAgent,
    prepareGroupRuntimeAgent,
  };
}
export type RoomRuntime = ReturnType<typeof createRoomRuntime>;
