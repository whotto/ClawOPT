import axios from 'axios';
import express from 'express';

import type { SessionManager } from '../../collab/sessions';
import type { DB } from '../../core/db';
import {
  PACK_AGENT_NOT_FOUND_ERROR_CODE,
  PACK_FETCH_FAILED_ERROR_CODE,
  PACK_SOURCE_REQUIRED_ERROR_CODE,
  PACK_TEAM_NOT_FOUND_ERROR_CODE,
  PACK_URL_BLOCKED_ERROR_CODE,
} from '../../core/http';
import { isBlockedIpAddress, isPrivateHostname, systemResolver } from '../../core/net';
import type { AgentProvisioner } from '../agents/agent-provisioner';
import type { AgentSettings } from '../agents/agent-settings';
import { getCurrentAppVersionInfo } from '../update/app-version';
import {
  buildAgentEntry,
  buildPack,
  type ClawPack,
  MAX_PACK_BYTES,
  type PackAgent,
  PackError,
  type PackTeam,
  type PackWarning,
  parsePack,
} from './agent-pack';

/**
 * 主机名是否指向内网。字面量检查不够：`localtest.me`、`127.0.0.1.nip.io` 这类域名
 * 长得像公网，解析出来却是回环地址。所以还要把名字解出来、**每一条记录**都查一遍。
 * 判据与出站 Webhook 共用 `core/net`，不在这里另写一份。
 */
async function resolvesToPrivateHost(hostname: string): Promise<string | null> {
  if (isPrivateHostname(hostname)) return hostname;
  try {
    const records = await systemResolver(hostname);
    for (const record of records) {
      if (isBlockedIpAddress(record.address)) return record.address;
    }
  } catch {
    // 解析不了的名字交给后续请求自己失败，不在这里下结论
  }
  return null;
}

/** 只允许 http/https 的公网地址；**重定向后的最终地址也要再查一次**。 */
function assertFetchableUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PackError(PACK_FETCH_FAILED_ERROR_CODE, rawUrl);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PackError(PACK_URL_BLOCKED_ERROR_CODE, parsed.protocol);
  }
  return parsed;
}

/** 语法检查 + 解析检查，两道都过才允许服务端去拉。 */
async function assertFetchableUrlResolved(rawUrl: string): Promise<URL> {
  const parsed = assertFetchableUrl(rawUrl);
  const privateAddress = await resolvesToPrivateHost(parsed.hostname);
  if (privateAddress !== null) {
    throw new PackError(PACK_URL_BLOCKED_ERROR_CODE, privateAddress);
  }
  return parsed;
}

/**
 * 拉取远端包。只允许 http/https 的公网地址。
 *
 * 只查首个地址是不够的：一个公网 URL 可以 302 到 127.0.0.1，服务端就成了跳板。
 * gist 的 /raw/ 本身就会跨主机跳到 gist.githubusercontent.com，所以这条路径上
 * 重定向是常态而不是异常——最终落点必须再查一次。
 */
async function fetchRemotePack(rawUrl: string): Promise<Buffer> {
  const parsed = await assertFetchableUrlResolved(rawUrl);

  const response = await axios.get<ArrayBuffer>(parsed.toString(), {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: MAX_PACK_BYTES,
    maxBodyLength: MAX_PACK_BYTES,
    maxRedirects: 3,
    validateStatus: status => status >= 200 && status < 300,
  });
  const finalUrl = (response.request as any)?.res?.responseUrl;
  if (typeof finalUrl === 'string' && finalUrl && finalUrl !== parsed.toString()) {
    await assertFetchableUrlResolved(finalUrl);
  }
  return Buffer.from(response.data);
}

/** 请求体或上传文件里取出包。两种入口，一套解析。 */
export async function readPackFromRequest(req: express.Request): Promise<ClawPack> {
  const uploaded = (req as any).file as { buffer?: Buffer } | undefined;
  if (uploaded?.buffer?.length) {
    return parsePack(uploaded.buffer);
  }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (url) {
    return parsePack(await fetchRemotePack(url));
  }
  throw new PackError(PACK_SOURCE_REQUIRED_ERROR_CODE);
}

/**
 * `.clawpack` 附带工作流的出入口，由自动化模块提供（结构化类型，control 不依赖 automation 的实现）。
 * 导入只建定义、不运行，校验与凭据扫描都在对方那条链上。
 */
export type PackWorkflowBundles = {
  exportEnvelopes(ids: string[]): unknown[];
  summarize(envelopes: unknown[]): Array<{ name: string; nodes: number; edges: number; valid: boolean; errorCode?: string }>;
  importEnvelopes(envelopes: unknown[], agentIdMap: Record<string, string>): Array<{ name: string; status: 'created' | 'failed'; workflowId?: string; errorCode?: string }>;
};

export type PackServiceDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  sessionManager: SessionManager;
  agentSettings: AgentSettings;
  workflowPacks: PackWorkflowBundles;
};

export function createPackService(ctx: PackServiceDeps) {
  const { agentProvisioner, db, sessionManager } = ctx;
  const { readEffectiveAgentRuntimeSettings } = ctx.agentSettings;

  function buildPackAgentEntry(agentId: string, displayName: string, options: any, warnings: PackWarning[]): PackAgent {
    const entry = buildAgentEntry(agentId, displayName, agentProvisioner.getWorkspacePath(agentId), options, warnings);
    const session = sessionManager.getSession(agentId);
    const runtimeSettings = readEffectiveAgentRuntimeSettings(session, agentId);
    entry.runtime = {
      runtimeMode: runtimeSettings.runtimeMode,
      systemPromptMode: runtimeSettings.systemPromptMode,
      toolMode: runtimeSettings.toolMode,
      processStartTag: session?.process_start_tag || '',
      processEndTag: session?.process_end_tag || '',
    };
    if (options.includeModelConfig) {
      const modelConfig = agentProvisioner.readAgentModelConfig(agentId);
      entry.model = {
        model: modelConfig.modelOverride,
        fallbackMode: modelConfig.fallbackMode,
        fallbacks: modelConfig.fallbacks,
      };
    }
    return entry;
  }

  /**
   * 按请求组装一个包。导出与分享共用同一条组装路径——两条路各拼一次的话，
   * 迟早出现「下载下来的包」和「分享出去的包」内容不一致。
   */
  function buildPackFromRequest(body: any): { pack: ClawPack; name: string } | { error: string; params?: Record<string, string> } {
    const kind = body?.kind === 'team' ? 'team' : 'agent';
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    const options = {
      includeMemory: body?.includeMemory === true,
      includeAutomations: body?.includeAutomations !== false,
      includeModelConfig: body?.includeModelConfig === true,
    };
    const warnings: PackWarning[] = [];

    let agents: PackAgent[] = [];
    let team: PackTeam | null = null;
    let name = '';
    let summary = '';

    if (kind === 'agent') {
      const session = sessionManager.getSession(id);
      if (!session) return { error: PACK_AGENT_NOT_FOUND_ERROR_CODE, params: { agentId: id } };
      agents = [buildPackAgentEntry(id, session.name, options, warnings)];
      name = session.name;
      summary = '';
    } else {
      const group = db.getGroupChat(id);
      if (!group) return { error: PACK_TEAM_NOT_FOUND_ERROR_CODE, params: { groupId: id } };
      const members = db.getGroupMembers(id);
      agents = members.map(member => {
        const session = sessionManager.getSession(member.agent_id);
        if (!session) {
          warnings.push({ code: 'memberMissing', detail: member.agent_id });
          return null;
        }
        return buildPackAgentEntry(member.agent_id, session.name, options, warnings);
      }).filter((entry): entry is PackAgent => entry !== null);
      team = {
        id: group.id,
        name: group.name,
        description: group.description || '',
        systemPrompt: group.system_prompt || '',
        processStartTag: group.process_start_tag || '',
        processEndTag: group.process_end_tag || '',
        maxChainDepth: group.max_chain_depth ?? 6,
        members: members.map((member, index) => ({
          agentId: member.agent_id,
          displayName: member.display_name,
          roleDescription: member.role_description || '',
          position: index,
        })),
      };
      name = group.name;
      summary = group.description || '';
    }

    if (!agents.length) return { error: PACK_AGENT_NOT_FOUND_ERROR_CODE, params: { agentId: id } };

    const workflowIds = Array.isArray(body?.includeWorkflows)
      ? [...new Set((body.includeWorkflows as unknown[]).filter((item): item is string => typeof item === 'string' && item.length > 0))]
      : [];
    let workflows: unknown[] = [];
    if (workflowIds.length) {
      try {
        workflows = ctx.workflowPacks.exportEnvelopes(workflowIds);
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'workflows.notFound';
        return { error: code };
      }
    }

    return {
      name,
      pack: buildPack({
        kind,
        name,
        summary,
        appVersion: getCurrentAppVersionInfo().version,
        agents,
        team,
        options,
        warnings,
        workflows,
      }),
    };
  }

  return {
    buildPackFromRequest,
    summarizeWorkflows: (pack: ClawPack) => ctx.workflowPacks.summarize(pack.workflows ?? []),
    installWorkflows: (pack: ClawPack, agentIdMap: Record<string, string>) => ctx.workflowPacks.importEnvelopes(pack.workflows ?? [], agentIdMap),
  };
}
export type PackService = ReturnType<typeof createPackService>;
