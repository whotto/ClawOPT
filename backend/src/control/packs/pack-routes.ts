import multer from 'multer';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  createNextGroupRuntimeSessionEpoch,
  ensureGroupWorkspace,
  validateGroupId,
} from '../../collab/rooms';
import type { SessionManager } from '../../collab/sessions';
import type { AuthMiddleware } from '../../core/auth';
import type { DB } from '../../core/db';
import {
  buildStructuredApiError,
  PACK_GH_MISSING_ERROR_CODE,
  PACK_GH_UNAUTHENTICATED_ERROR_CODE,
  PACK_GIST_FAILED_ERROR_CODE,
  PRESET_INSTALL_FAILED_ERROR_CODE,
  type RouteApp,
} from '../../core/http';
import type { AgentProvisioner } from '../agents/agent-provisioner';
import {
  normalizeAgentRuntimeMode,
  normalizeAgentSystemPromptMode,
  normalizeAgentToolMode,
  normalizeFallbackList,
  normalizeFallbackMode,
} from '../agents/agent-settings';
import {
  MAX_PACK_BYTES,
  PackError,
  readPackFile,
  sanitizeFileName,
  serializePack,
  writeAgentFiles,
} from './agent-pack';
import { type PackService, readPackFromRequest } from './pack-service';

// ── 预设装配（内容层）────────────────────────────────────────────────────
// 「一键复制一支 AI 团队」的实际入口。装配分两条路，因为 API 只覆盖一半：
//   ① 建 Agent + 写 6 份 markdown（走 sessionManager + agentProvisioner，与手工建 Agent 同一条链路）
//   ② MEMORY.md / BOOTSTRAP.md / skills/ / reference/ / automations.sh 直接写工作区
// 详见 docs/preset-gap.md。

// ── 智能体 / 团队打包（.clawpack）─────────────────────────────────────────
// 把这台机器上的一个 Agent 或一个团队打成包发给别人，对方在自己的 ClawOPT 上装回去。
// 导入侧的三道闸门：路径白名单（agent-pack.ts）、装之前先预演、导入不执行任何东西。

const packUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PACK_BYTES } });

export type PackRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  sessionManager: SessionManager;
  packs: PackService;
  auth: AuthMiddleware;
};

export function registerPackRoutes(app: RouteApp, ctx: PackRoutesDeps): void {
  const { agentProvisioner, db, sessionManager } = ctx;
  const { buildPackFromRequest, summarizeWorkflows, installWorkflows } = ctx.packs;
  const { requireAdminAuth } = ctx.auth;

  app.post('/api/packs/export', requireAdminAuth, async (req, res) => {
    try {
      const built = buildPackFromRequest(req.body);
      if ('error' in built) {
        return res.status(404).json(buildStructuredApiError(built.error, null, built.params || null));
      }
      const body = serializePack(built.pack);
      const fileName = `${sanitizeFileName(built.name)}.clawpack`;

      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('X-Clawpack-Manifest', encodeURIComponent(JSON.stringify(built.pack.manifest)));
      res.send(body);
    } catch (error: any) {
      res.status(500).json(buildStructuredApiError(PRESET_INSTALL_FAILED_ERROR_CODE, error?.message || String(error)));
    }
  });

  /**
   * 分享：把包上传成一个**你自己账号下的**私密 gist，换一条链接回来。
   *
   * 为什么走 `gh` 而不是自建中转：托管成本、包的有效期、以及「别人上传的东西经我们
   * 的服务器分发」这份责任，都不该由本项目背。用分享者自己的 GitHub 账号，这三样
   * 一起消失，我们只负责把文件递过去。
   *
   * 上传的是**未压缩的 JSON**：gist 是文本载体，塞 gzip 二进制会被破坏；而 JSON 本身
   * 就是这个包格式的可读形态，对方在网页上就能看清里面有什么再决定装不装。
   * 导入侧的 parsePack 同时接受 gzip 与纯 JSON，两条路一份解析。
   */
  app.post('/api/packs/share', requireAdminAuth, async (req, res) => {
    let tempPath = '';
    let tempDir = '';
    try {
      const built = buildPackFromRequest(req.body);
      if ('error' in built) {
        return res.status(404).json(buildStructuredApiError(built.error, null, built.params || null));
      }

      // 探针用 `gh api user` 而不是 `gh auth status`：后者在旧版 gh 里强制校验
      // `repo` + `read:org` 两个 scope，于是一个只带 `gist`（分享真正需要的那个）的
      // 令牌会被判成不可用——探针比它守护的操作更严，就会拦下本来能跑的调用。
      // `gh api user` 只要求令牌本身有效，与建 gist 的实际要求对齐。
      const ghReady = await new Promise<{ ok: boolean; detail: string }>(resolve => {
        const probe = spawn('gh', ['api', 'user', '-q', '.login']);
        let stderr = '';
        probe.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        probe.on('error', () => resolve({ ok: false, detail: 'notInstalled' }));
        probe.on('close', code => resolve({ ok: code === 0, detail: stderr.trim() }));
      });
      if (!ghReady.ok) {
        const code = ghReady.detail === 'notInstalled' ? PACK_GH_MISSING_ERROR_CODE : PACK_GH_UNAUTHENTICATED_ERROR_CODE;
        return res.status(400).json(buildStructuredApiError(code, ghReady.detail === 'notInstalled' ? null : ghReady.detail));
      }

      // 放进一个临时目录而不是给文件名加前缀：gist 里的文件名就是这个文件的 basename，
      // 对方看到的是「科学决策.clawpack.json」还是「clawpack-1787402967113-科学决策.clawpack.json」，
      // 差别全在这里。目录名带随机后缀足够避免撞车。
      const fileName = `${sanitizeFileName(built.name)}.clawpack.json`;
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawpack-'));
      tempPath = path.join(tempDir, fileName);
      fs.writeFileSync(tempPath, JSON.stringify(built.pack, null, 1), 'utf-8');

      const manifest = built.pack.manifest;
      const description = `${built.pack.kind === 'team' ? 'ClawOPT team' : 'ClawOPT agent'}: ${built.name} · ${manifest.agentCount} agents · ${manifest.skillCount} skills`;

      const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(resolve => {
        const proc = spawn('gh', ['gist', 'create', '--public=false', '--desc', description, tempPath]);
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', chunk => { stdout += chunk.toString(); });
        proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
        proc.on('error', () => resolve({ stdout: '', stderr: 'spawn failed', code: 1 }));
        proc.on('close', code => resolve({ stdout, stderr, code }));
      });

      if (result.code !== 0) {
        return res.status(502).json(buildStructuredApiError(PACK_GIST_FAILED_ERROR_CODE, result.stderr.trim() || null));
      }

      const gistUrl = result.stdout.trim().split(/\s+/).pop() || '';
      if (!/^https:\/\/gist\.github\.com\//.test(gistUrl)) {
        return res.status(502).json(buildStructuredApiError(PACK_GIST_FAILED_ERROR_CODE, result.stdout.trim() || null));
      }
      // gist 的 /raw/<file> 会 302 到 gist.githubusercontent.com，导入侧照常拉得到
      const rawUrl = `${gistUrl}/raw/${path.basename(tempPath)}`;

      res.json({ success: true, gistUrl, rawUrl, manifest });
    } catch (error: any) {
      res.status(500).json(buildStructuredApiError(PACK_GIST_FAILED_ERROR_CODE, error?.message || String(error)));
    } finally {
      // 临时文件里是完整的智能体内容，别留在 /tmp
      if (tempPath) { try { fs.unlinkSync(tempPath); } catch { /* 已经不在就算了 */ } }
      if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 同上 */ } }
    }
  });

  /** 预演：解析包、报清楚里面有什么、哪些 ID 会撞车。一个字节都不写。 */
  app.post('/api/packs/inspect', requireAdminAuth, packUpload.single('file'), async (req, res) => {
    try {
      const pack = await readPackFromRequest(req);
      const agents = pack.agents.map(agent => ({
        id: agent.id,
        name: agent.name,
        skills: agent.skills,
        fileCount: agent.files.length,
        hasAutomations: agent.files.some(file => file.path === 'automations.sh'),
        hasMemory: agent.files.some(file => file.path === 'MEMORY.md'),
        conflict: Boolean(sessionManager.getSession(agent.id)),
        // 只报事实：这个显示名现在有没有人在用。会不会真的撞车取决于用户接下来
        // 是覆盖同一个 ID（不会多出一条）还是改名另存（会），那是前端才知道的事。
        nameConflict: sessionManager.getAllSessions().some(existing => existing.name === agent.name),
        soulPreview: readPackFile(agent, 'SOUL.md').slice(0, 400),
      }));
      res.json({
        success: true,
        kind: pack.kind,
        exportedAt: pack.exportedAt,
        exportedBy: pack.exportedBy,
        manifest: pack.manifest,
        team: pack.team ? { ...pack.team, conflict: Boolean(db.getGroupChat(pack.team.id)) } : null,
        agents,
        workflows: summarizeWorkflows(pack),
      });
    } catch (error: any) {
      const code = error instanceof PackError ? error.code : PRESET_INSTALL_FAILED_ERROR_CODE;
      const detail = error instanceof PackError ? error.detail : (error?.message || String(error));
      res.status(400).json(buildStructuredApiError(code, detail || null));
    }
  });

  app.post('/api/packs/install', requireAdminAuth, packUpload.single('file'), async (req, res) => {
    try {
      const pack = await readPackFromRequest(req);
      const rawRename = req.body?.rename;
      const rename: Record<string, string> = typeof rawRename === 'string'
        ? JSON.parse(rawRename || '{}')
        : (rawRename && typeof rawRename === 'object' ? rawRename : {});
      const rawRenameNames = req.body?.renameNames;
      const renameNames: Record<string, string> = typeof rawRenameNames === 'string'
        ? JSON.parse(rawRenameNames || '{}')
        : (rawRenameNames && typeof rawRenameNames === 'object' ? rawRenameNames : {});
      const overwrite = req.body?.overwrite === true || req.body?.overwrite === 'true';
      const installTeam = req.body?.installTeam !== false && req.body?.installTeam !== 'false';
      const applyModel = req.body?.applyModel === true || req.body?.applyModel === 'true';

      const idMap: Record<string, string> = {};
      const results: any[] = [];

      for (const agent of pack.agents) {
        const requestedId = typeof rename[agent.id] === 'string' && rename[agent.id].trim() ? rename[agent.id].trim() : agent.id;
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(requestedId)) {
          results.push({ sourceId: agent.id, targetId: requestedId, status: 'failed', error: 'invalid id' });
          continue;
        }
        const existing = sessionManager.getSession(requestedId);
        if (existing && !overwrite) {
          results.push({ sourceId: agent.id, targetId: requestedId, status: 'skipped', skills: agent.skills });
          continue;
        }
        const displayName = typeof renameNames[agent.id] === 'string' && renameNames[agent.id].trim()
          ? renameNames[agent.id].trim()
          : agent.name;
        try {
          if (!existing) {
            sessionManager.createSession({
              id: requestedId,
              name: displayName,
              process_start_tag: agent.runtime?.processStartTag,
              process_end_tag: agent.runtime?.processEndTag,
              runtime_mode: normalizeAgentRuntimeMode(agent.runtime?.runtimeMode),
              system_prompt_mode: normalizeAgentSystemPromptMode(agent.runtime?.systemPromptMode),
              tool_mode: normalizeAgentToolMode(agent.runtime?.toolMode),
            });
          }
          await agentProvisioner.provision({
            agentId: requestedId,
            identityContent: readPackFile(agent, 'IDENTITY.md') || undefined,
            soulContent: readPackFile(agent, 'SOUL.md') || undefined,
            agentsContent: readPackFile(agent, 'AGENTS.md') || undefined,
            userContent: readPackFile(agent, 'USER.md') || undefined,
            toolsContent: readPackFile(agent, 'TOOLS.md') || undefined,
            heartbeatContent: readPackFile(agent, 'HEARTBEAT.md') || undefined,
            model: applyModel ? (agent.model?.model || undefined) : undefined,
            fallbackMode: applyModel ? normalizeFallbackMode(agent.model?.fallbackMode) ?? 'inherit' : undefined,
            fallbacks: applyModel ? normalizeFallbackList(agent.model?.fallbacks) : undefined,
            systemPromptMode: normalizeAgentSystemPromptMode(agent.runtime?.systemPromptMode),
            toolMode: normalizeAgentToolMode(agent.runtime?.toolMode),
          });
          sessionManager.updateSession(requestedId, { agentId: requestedId, name: displayName });
          const written = writeAgentFiles(agent, agentProvisioner.getWorkspacePath(requestedId));
          idMap[agent.id] = requestedId;
          results.push({
            sourceId: agent.id,
            targetId: requestedId,
            targetName: displayName,
            status: existing ? 'updated' : 'created',
            fileCount: written,
            skills: agent.skills,
          });
        } catch (error: any) {
          results.push({ sourceId: agent.id, targetId: requestedId, status: 'failed', error: error?.message || String(error) });
        }
      }

      let teamResult: any = null;
      if (pack.kind === 'team' && pack.team && installTeam) {
        const sourceTeam = pack.team;
        const requestedTeamId = typeof rename[`team:${sourceTeam.id}`] === 'string' && rename[`team:${sourceTeam.id}`].trim()
          ? rename[`team:${sourceTeam.id}`].trim()
          : sourceTeam.id;
        const validation = validateGroupId(requestedTeamId);
        if (validation.issue) {
          teamResult = { targetId: requestedTeamId, status: 'failed', error: validation.issue };
        } else if (db.getGroupChat(validation.normalizedId) && !overwrite) {
          teamResult = { targetId: validation.normalizedId, status: 'skipped' };
        } else {
          const teamId = validation.normalizedId;
          const now = new Date().toISOString();
          const existingTeam = db.getGroupChat(teamId);
          const allGroups = db.getGroupChats();
          const maxPosition = allGroups.length > 0 ? Math.max(...allGroups.map(group => group.position || 0)) : -1;
          db.saveGroupChat({
            id: teamId,
            name: sourceTeam.name,
            description: sourceTeam.description || '',
            system_prompt: sourceTeam.systemPrompt || '',
            process_start_tag: sourceTeam.processStartTag || '',
            process_end_tag: sourceTeam.processEndTag || '',
            max_chain_depth: sourceTeam.maxChainDepth ?? 6,
            runtime_session_epoch: existingTeam?.runtime_session_epoch ?? createNextGroupRuntimeSessionEpoch(),
            position: existingTeam?.position ?? maxPosition + 1,
            created_at: existingTeam?.created_at || now,
            updated_at: now,
          });
          const members = sourceTeam.members
            .map(member => ({ ...member, targetId: idMap[member.agentId] }))
            .filter(member => Boolean(member.targetId));
          members.forEach((member, index) => {
            db.saveGroupMember({
              id: `gm_${teamId}_${member.targetId}`,
              group_id: teamId,
              agent_id: member.targetId as string,
              display_name: member.displayName || (member.targetId as string),
              role_description: member.roleDescription || '',
              position: index,
            });
          });
          ensureGroupWorkspace(teamId);
          teamResult = {
            targetId: teamId,
            status: existingTeam ? 'updated' : 'created',
            memberCount: members.length,
            droppedMembers: sourceTeam.members.length - members.length,
          };
        }
      }

      // 附带的工作流：只建定义，不运行；Agent 引用按本次装包的改名映射过去。
      const installWorkflowsFlag = req.body?.installWorkflows !== false && req.body?.installWorkflows !== 'false';
      const workflowResults = installWorkflowsFlag && pack.workflows?.length ? installWorkflows(pack, idMap) : [];

      const failed = results.filter(result => result.status === 'failed');
      res.json({
        success: failed.length === 0,
        results,
        team: teamResult,
        workflows: workflowResults,
        manifest: pack.manifest,
      });
    } catch (error: any) {
      const code = error instanceof PackError ? error.code : PRESET_INSTALL_FAILED_ERROR_CODE;
      const detail = error instanceof PackError ? error.detail : (error?.message || String(error));
      res.status(400).json(buildStructuredApiError(code, detail || null));
    }
  });
}
