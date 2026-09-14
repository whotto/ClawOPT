import type { SessionManager } from '../../collab/sessions';
import type { AuthMiddleware } from '../../core/auth';
import {
  buildStructuredApiError,
  PRESET_INSTALL_FAILED_ERROR_CODE,
  PRESET_NO_ROLE_SELECTED_ERROR_CODE,
  PRESET_NOT_FOUND_ERROR_CODE,
  type RouteApp,
} from '../../core/http';
import type { AgentProvisioner } from '../agents/agent-provisioner';
import {
  buildRolePayload,
  listPresets,
  loadPreset,
  planRole,
  presetsDirExists,
  resolveParamValues,
  writeWorkspaceExtras,
} from './preset-installer';

export type PresetRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  sessionManager: SessionManager;
  auth: AuthMiddleware;
};

export function registerPresetRoutes(app: RouteApp, ctx: PresetRoutesDeps): void {
  const { agentProvisioner, sessionManager } = ctx;
  const { requireAdminAuth } = ctx.auth;

  app.get('/api/presets', (_req, res) => {
    if (!presetsDirExists()) {
      return res.json({ success: true, presets: [] });
    }
    const summaries = listPresets().map(summary => {
      const detail = loadPreset(summary.id);
      // 坏掉的预设也回给前端：目录还占着这个 id，静默过滤会让界面上无迹可寻。
      if (!detail || summary.broken) {
        return {
          id: summary.id,
          name: summary.name,
          version: '',
          tagline: summary.tagline || '',
          description: '',
          author: '',
          roles: [],
          params: [],
          postInstall: [],
          broken: summary.broken || 'preset.json 无法读取',
        };
      }
      const roles = detail.roles.map(role => ({
        id: role.id,
        name: role.name,
        emoji: role.emoji || '',
        position: role.position || '',
        slogan: role.slogan || '',
        skills: role.skills || [],
        externalSkills: role.externalSkills || [],
        recommended: role.recommended !== false,
        note: role.note || '',
        installed: Boolean(sessionManager.getSession(role.id)),
      }));
      return {
        broken: undefined as string | undefined,
        id: detail.id,
        name: detail.name,
        version: detail.version || '',
        tagline: detail.tagline || '',
        description: detail.description || '',
        author: detail.author || '',
        roles,
        params: detail.params.map(param => ({
          key: param.key,
          label: param.label || param.key,
          hint: param.hint || '',
          default: param.default || '',
          examples: Array.isArray(param.examples) ? param.examples : [],
        })),
        postInstall: Array.isArray(detail.postInstall) ? detail.postInstall : [],
      };
    }).filter(Boolean);

    res.json({ success: true, presets: summaries });
  });

  app.post('/api/presets/:presetId/install', requireAdminAuth, async (req, res) => {
    const preset = loadPreset(req.params.presetId);
    if (!preset) {
      return res.status(404).json(buildStructuredApiError(PRESET_NOT_FOUND_ERROR_CODE, null, { presetId: req.params.presetId }));
    }

    const dryRun = req.body?.dryRun === true;
    const overwrite = req.body?.overwrite === true;
    const requestedIds: string[] = Array.isArray(req.body?.roleIds)
      ? req.body.roleIds.filter((id: unknown): id is string => typeof id === 'string')
      : [];
    const roles = requestedIds.length
      ? preset.roles.filter(role => requestedIds.includes(role.id))
      : preset.roles.filter(role => role.recommended !== false);

    if (!roles.length) {
      return res.status(400).json(buildStructuredApiError(PRESET_NO_ROLE_SELECTED_ERROR_CODE));
    }

    const vals = resolveParamValues(preset, req.body?.params);
    const results: any[] = [];

    for (const role of roles) {
      const workspaceDir = agentProvisioner.getWorkspacePath(role.id);
      const existing = sessionManager.getSession(role.id);
      const plan = planRole(preset.id, preset, role, vals, workspaceDir, Boolean(existing));

      if (dryRun) {
        results.push({ ...plan, status: existing ? (overwrite ? 'willUpdate' : 'willSkip') : 'willCreate' });
        continue;
      }

      if (existing && !overwrite) {
        results.push({ ...plan, status: 'skipped' });
        continue;
      }

      try {
        const payload = buildRolePayload(preset.id, role, vals);
        if (!existing) {
          sessionManager.createSession({ id: role.id, name: role.name });
        } else {
          sessionManager.updateSession(role.id, { name: role.name });
        }
        await agentProvisioner.provision({ agentId: role.id, ...payload });
        sessionManager.updateSession(role.id, { agentId: role.id });
        const written = writeWorkspaceExtras(preset.id, preset, role, vals, workspaceDir);
        results.push({ ...plan, workspaceFileCount: written, status: existing ? 'updated' : 'created' });
      } catch (error: any) {
        // 失败要把这一轮刚建的 session 撤掉。留着的话，下次重试会被判成
        // 「已存在 → 跳过」，界面还显示「已安装」——用户不勾覆盖就永远修不好。
        if (!existing) {
          try { sessionManager.deleteSession(role.id); } catch { /* 撤不掉就让结果里的失败信息说话 */ }
        }
        results.push({ ...plan, status: 'failed', error: error?.message || String(error) });
      }
    }

    const failed = results.filter(r => r.status === 'failed');
    res.json({
      success: failed.length === 0,
      dryRun,
      errorCode: failed.length ? PRESET_INSTALL_FAILED_ERROR_CODE : undefined,
      results,
      postInstall: Array.isArray(preset.postInstall) ? preset.postInstall : [],
    });
  });
}
