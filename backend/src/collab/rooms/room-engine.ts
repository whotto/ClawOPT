import express from 'express';

import {
  type AgentProvisioner,
  type AgentSettings,
  type ImageGenerationService,
} from '../../control';
import type { ConfigManager } from '../../core/config';
import type { DB } from '../../core/db';
import type { GatewayConnections } from '../../openclaw';
import { ConfigReadError } from '../../openclaw';
import { rewriteOpenClawMediaPaths, type SessionManager } from '../sessions';
import { GroupChatEngine } from './group-chat-engine';
import { withStructuredGroupMessage } from './room-messages';
import { getGroupWorkspaceForDisplay } from './room-reconciliation';
import type { RoomRuntime } from './room-runtime';

export type RoomEngineDeps = {
  agentProvisioner: AgentProvisioner;
  configManager: ConfigManager;
  db: DB;
  sessionManager: SessionManager;
  roomRuntime: RoomRuntime;
  agentSettings: AgentSettings;
  imageGeneration: ImageGenerationService;
  gatewayConnections: GatewayConnections;
};

export function createRoomEngine(ctx: RoomEngineDeps) {
  const { agentProvisioner, configManager, db, sessionManager } = ctx;
  const { prepareGroupRuntimeAgent } = ctx.roomRuntime;
  const { shouldInjectHostTakeoverInstruction } = ctx.agentSettings;
  const { buildImageGenerationStartProcessContent, getConfiguredDirectImageGenerationModel, tryGenerateImageForPrompt } = ctx.imageGeneration;
  const { getConnection } = ctx.gatewayConnections;

  // ========== Group Chat Engine ==========
  const groupChatEngine = new GroupChatEngine(db, getConnection, (agentId) => {
    // First, check if there's a custom session for this agent
    const sessions = sessionManager.getAllSessions();
    const session = sessions.find((s: any) => s.agentId === agentId);
    if (session) {
      // group-chat-engine.ts 本 sprint 明确不碰（Sprint 3 范围）——这个 resolver
      // 是它的调用入口，不确定它在哪些调用路径下没有自己的 try/catch，所以这里
      // 显式吞掉 ConfigReadError、退回下面 characters 表的兜底，保持这个入口原有
      // 的容错行为不变；真实失败已经在 readAgentModel 内部往上抛给了其它调用点。
      let customModel: string | null = null;
      try {
        customModel = agentProvisioner.readAgentModel(agentId);
      } catch (err) {
        if (!(err instanceof ConfigReadError)) throw err;
        // 红线 C：退回 characters 表是有意的容错，但**静默地退**不是。
        // 不打这行日志的话，一个「openclaw.json 读不动」会表现为
        // 「这个 Agent 忽然用上了另一个模型」，没有任何东西指向真实原因。
        console.warn(
          `[GroupChat] 读取 agent 模型失败（${err.reason}），回落 characters 表：agentId=${agentId}`,
        );
      }
      if (customModel) return customModel;
    }

    // Fallback to characters table for hardcoded system agents
    const chars = db.getCharacters();
    const c = chars.find(x => x.agentId === agentId);
    return c?.model || '';
  }, () => {
    const configuredLanguage = configManager.getConfig().language;
    return configuredLanguage === 'zh-TW' || configuredLanguage === 'en' ? configuredLanguage : 'zh-CN';
  }, prepareGroupRuntimeAgent, tryGenerateImageForPrompt, () => {
    const modelId = getConfiguredDirectImageGenerationModel();
    return modelId ? buildImageGenerationStartProcessContent(modelId) : null;
  }, (agentId) => {
    const sessionInfo = db.getSessionByAgentId(agentId) || db.getSession(agentId);
    return shouldInjectHostTakeoverInstruction(sessionInfo, agentId);
  });

  // SSE clients per group
  const groupSSEClients = new Map<string, Set<express.Response>>();

  groupChatEngine.on('message', (msg: any) => {
    const clients = groupSSEClients.get(msg.groupId);
    if (clients) {
      const data = JSON.stringify({
        type: 'message',
        data: withStructuredGroupMessage(msg, { groupId: msg.groupId }),
      });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  groupChatEngine.on('delete', (info: any) => {
    const clients = groupSSEClients.get(info.groupId);
    if (clients) {
      const data = JSON.stringify({ type: 'delete', id: info.id, parent_id: info.parent_id ?? null });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  groupChatEngine.on('delta', (info: any) => {
    const clients = groupSSEClients.get(info.groupId);
    if (clients) {
      const data = JSON.stringify({
        type: 'delta',
        ...info,
        content: typeof info.content === 'string'
          ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspaceForDisplay(info.groupId))
          : info.content,
      });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  groupChatEngine.on('edit', (info: any) => {
    const clients = groupSSEClients.get(info.groupId);
    if (clients) {
      const data = JSON.stringify({
        type: 'edit',
        ...info,
        content: typeof info.content === 'string'
          ? rewriteOpenClawMediaPaths(info.content, getGroupWorkspaceForDisplay(info.groupId))
          : info.content,
      });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  groupChatEngine.on('typing', (info: any) => {
    const clients = groupSSEClients.get(info.groupId);
    if (clients) {
      const data = JSON.stringify({ type: 'typing', data: info });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  groupChatEngine.on('typing_done', (info: any) => {
    const clients = groupSSEClients.get(info.groupId);
    if (clients) {
      const data = JSON.stringify({ type: 'typing_done', data: info });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  groupChatEngine.on('run_state', (info: any) => {
    const clients = groupSSEClients.get(info.groupId);
    if (clients) {
      const data = JSON.stringify({ type: 'run_state', data: info });
      for (const client of clients) {
        try { client.write(`data: ${data}\n\n`); } catch {}
      }
    }
  });

  return {
    groupChatEngine,
    groupSSEClients,
  };
}
export type RoomEngine = ReturnType<typeof createRoomEngine>;
