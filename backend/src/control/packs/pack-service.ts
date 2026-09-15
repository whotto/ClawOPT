import axios from 'axios';
import express from 'express';
import type { LookupFunction } from 'net';

import type { SessionManager } from '../../collab/sessions';
import type { DB } from '../../core/db';
import {
  PACK_AGENT_NOT_FOUND_ERROR_CODE,
  PACK_FETCH_FAILED_ERROR_CODE,
  PACK_SOURCE_REQUIRED_ERROR_CODE,
  PACK_TEAM_NOT_FOUND_ERROR_CODE,
  PACK_URL_BLOCKED_ERROR_CODE,
} from '../../core/http';
import { checkOutboundUrl, pinnedLookup, type Resolver } from '../../core/net';
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

/** 远端拉取最多跟几跳重定向（gist 的 /raw/ 会跨主机跳一次）。 */
export const MAX_PACK_REDIRECTS = 3;

export type PackHopResponse = { status: number; location?: string; data: ArrayBuffer | Buffer };
export type PackHopFetcher = (url: URL, lookup: LookupFunction) => Promise<PackHopResponse>;

const axiosHop: PackHopFetcher = async (url, lookup) => {
  const response = await axios.get<ArrayBuffer>(url.toString(), {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: MAX_PACK_BYTES,
    maxBodyLength: MAX_PACK_BYTES,
    // 重定向自己跟：每一跳先过出站策略再连，不让 HTTP 客户端替我们跳到内网。
    maxRedirects: 0,
    lookup: lookup as any,
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const location = response.headers?.location;
  return { status: response.status, location: typeof location === 'string' ? location : undefined, data: response.data };
};

/**
 * 拉取远端包。只允许 http/https 的公网地址，判据是 `core/net` 的唯一出站策略（不在这里另写一份）。
 *
 * 只查首个地址是不够的：一个公网 URL 可以 302 到 127.0.0.1，服务端就成了跳板。
 * gist 的 /raw/ 本身就会跨主机跳到 gist.githubusercontent.com，所以这条路径上重定向是常态——
 * **每一跳**都先过策略、再钉住校验过的 IP 去连（DNS rebinding 无从下手），不交给 HTTP 客户端自动跟。
 */
export async function fetchRemotePack(rawUrl: string, options: { resolver?: Resolver; fetchHop?: PackHopFetcher } = {}): Promise<Buffer> {
  const fetchHop = options.fetchHop ?? axiosHop;
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_PACK_REDIRECTS; hop += 1) {
    const verdict = await checkOutboundUrl(current, { resolver: options.resolver });
    if (!verdict.ok) {
      if (verdict.reason === 'invalidUrl' || verdict.reason === 'unresolvable') throw new PackError(PACK_FETCH_FAILED_ERROR_CODE, verdict.detail);
      throw new PackError(PACK_URL_BLOCKED_ERROR_CODE, verdict.detail);
    }
    const response = await fetchHop(verdict.url, pinnedLookup(verdict.addresses[0]));
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new PackError(PACK_FETCH_FAILED_ERROR_CODE, `HTTP ${response.status}`);
      current = new URL(response.location, verdict.url).toString();
      continue;
    }
    return Buffer.from(response.data as ArrayBuffer);
  }
  throw new PackError(PACK_FETCH_FAILED_ERROR_CODE, 'too many redirects');
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
