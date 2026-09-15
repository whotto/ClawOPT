import { randomUUID } from 'crypto';
import {
  type AgentProvisioner,
  type AgentSettings,
  normalizeAgentRuntimeMode,
  normalizeAgentSystemPromptMode,
  normalizeAgentToolMode,
  normalizeFallbackList,
  normalizeFallbackMode,
  RUNTIME_SETTINGS_CONFIG_READ_FALLBACK,
  withConfigReadFallback,
} from '../../control';
import type express from 'express';

import { type AuthMiddleware, getRequestIdentity, type ResourceAccess, sendResourceForbidden } from '../../core/auth';
import type { DB } from '../../core/db';
import {
  AGENT_CONFIG_READ_FAILED_ERROR_CODE,
  AGENT_ID_ALREADY_EXISTS_ERROR_CODE,
  AGENT_ID_CONTAINS_WHITESPACE_ERROR_CODE,
  AGENT_ID_REQUIRED_ERROR_CODE,
  buildStructuredApiError,
  MODEL_UPDATE_FAILED_ERROR_CODE,
  type RouteApp,
} from '../../core/http';
import type { GatewayConnections } from '../../openclaw';
import { abortOpenClawSessionRuns, buildOpenClawChatSessionKey, ConfigReadError } from '../../openclaw';
import type { RunCoordinator, RuntimePlatform } from '../../runtime';
import { normalizeExternalSessionConfig, parseExternalSessionConfig } from './external-chat-turn';
import type { UploadService } from '../../workspace';
import type { ChatLifecycle } from './chat-lifecycle';
import type { ChatRuns } from './chat-run-managers';
import {
  buildHistoryPageResponse,
  buildHistorySearchResponse,
  buildStructuredChatHttpError,
  type ChatMessages,
  getHistoryPageQueryParams,
} from './chat-messages';
import type { SessionManager } from './session-manager';
import type { SessionOrgStore, SessionOrigin } from './session-org-store';
import {
  resetAgentWorkspaceToInitialState,
  type SessionRuntime,
} from './session-runtime';

export type SessionListRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  sessionManager: SessionManager;
  agentSettings: AgentSettings;
  access: ResourceAccess;
};

/**
 * 单聊会话的数据面授权（P5a 用户 ↔ Agent）：路径参数里的会话必须看得见，否则 403 `auth.agentForbidden`。
 * 是中间件本身，请求到来时才读 `access`——路由登记期不调用上下文里的函数。
 */
export function chatSessionParamGuard(ctx: { access: ResourceAccess }, param: string): express.RequestHandler {
  return (req, res, next) => {
    if (ctx.access.canAccessChatSession(getRequestIdentity(req), String(req.params[param] ?? ''))) return next();
    return sendResourceForbidden(res);
  };
}

export function registerSessionListRoutes(app: RouteApp, ctx: SessionListRoutesDeps): void {
  const { agentProvisioner, sessionManager } = ctx;
  const { readEffectiveAgentRuntimeSettings } = ctx.agentSettings;

  // 会话列表（侧栏、Agents 页都用它）：member 只见授权 Agent 的会话。
  app.get('/api/sessions', (req, res) => {
    const identity = getRequestIdentity(req);
    const sessions = sessionManager.getAllSessions().filter((session) => ctx.access.canAccessChatSession(identity, session.id));
    const sessionsWithModel = sessions.map(({ external_session_id: _handle, external_session_resumable: _resumable, ...session }) => {
      if (session.external_runtime) {
        // 外部运行时会话：没有 OpenClaw 侧的模型与运行时设置；界面按 externalRuntime / externalConfig 显示。
        return { ...session, externalRuntime: session.external_runtime, externalConfig: parseExternalSessionConfig(session.external_config), model: '', configReadFailed: false };
      }
      // 配置读不动时退回旧的降级行为（model 空字符串、运行时设置退回默认值），
      // 不让整条列表 500——这里返回的是数组，没有顶层字段可挂标记位，所以
      // configReadFailed 挂在每一行上。
      const { value: runtimeSettingsValue, configReadFailed: runtimeFailed } = withConfigReadFallback(
        { runtimeMode: normalizeAgentRuntimeMode(session.runtime_mode), ...RUNTIME_SETTINGS_CONFIG_READ_FALLBACK },
        () => readEffectiveAgentRuntimeSettings(session, session.agentId),
      );
      const { value: model, configReadFailed: modelFailed } = withConfigReadFallback(
        '',
        () => agentProvisioner.readAgentModel(session.agentId) || '',
      );
      return {
        ...session,
        runtimeMode: runtimeSettingsValue.runtimeMode,
        systemPromptMode: runtimeSettingsValue.systemPromptMode,
        toolMode: runtimeSettingsValue.toolMode,
        model,
        configReadFailed: runtimeFailed || modelFailed,
      };
    });
    res.json(sessionsWithModel);
  });
}

export type SessionRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  sessionManager: SessionManager;
  chatRuns: ChatRuns;
  runCoordinator: RunCoordinator;
  runtimePlatform: Pick<RuntimePlatform, 'releaseOwner' | 'registry'>;
  chatLifecycle: ChatLifecycle;
  chatMessages: ChatMessages;
  sessionRuntime: SessionRuntime;
  agentSettings: AgentSettings;
  gatewayConnections: GatewayConnections;
  uploads: UploadService;
  access: ResourceAccess;
  auth: Pick<AuthMiddleware, 'requireAdminAuth'>;
  sessionOrg: Pick<SessionOrgStore, 'setOrigin' | 'clearGeneratedTitle'>;
};

/** 建会话时记下来历：只认 `diagnosis`（运行时管理页「让 AI 诊断」），其余一律当人建的。 */
export function normalizeSessionOrigin(raw: unknown): SessionOrigin {
  return raw === 'diagnosis' ? 'diagnosis' : 'human';
}

export function registerSessionRoutes(app: RouteApp, ctx: SessionRoutesDeps): void {
  const { agentProvisioner, db, sessionManager } = ctx;
  const { localChatOperationManager } = ctx.chatRuns;
  const { runCoordinator } = ctx;
  const { reconcileInactiveChatLatestMessage } = ctx.chatLifecycle;
  const { withStructuredChatMessage } = ctx.chatMessages;
  const { bumpSessionInterruptionEpoch, getSessionInterruptionEpoch, resetAgentRuntimeStateToInitialState, sessionInterruptionEpochs } = ctx.sessionRuntime;
  const { readEffectiveAgentRuntimeSettings } = ctx.agentSettings;
  const { disconnectConnection, getConnection } = ctx.gatewayConnections;
  const { clearStoredFilesBySessionKey } = ctx.uploads;
  const { requireAdminAuth } = ctx.auth;
  const guardSessionId = chatSessionParamGuard(ctx, 'id');
  const guardSessionParam = chatSessionParamGuard(ctx, 'sessionId');

  // 建 / 改 / 删会话会装配、改写、撤销 OpenClaw Agent（工作区文件、模型、openclaw.json）：属于控制面，admin 及以上。
  app.post('/api/sessions', requireAdminAuth, async (req, res) => {
    const { id, name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model, process_start_tag, process_end_tag } = req.body;
    const fallbackMode = normalizeFallbackMode(req.body?.fallbackMode) ?? 'inherit';
    const fallbacks = normalizeFallbackList(req.body?.fallbacks);
    const runtimeMode = normalizeAgentRuntimeMode(req.body?.runtimeMode ?? req.body?.runtime_mode);
    const systemPromptMode = normalizeAgentSystemPromptMode(req.body?.systemPromptMode ?? req.body?.system_prompt_mode);
    const toolMode = normalizeAgentToolMode(req.body?.toolMode ?? req.body?.tool_mode);

    const rawId = typeof id === 'string' ? id : '';
    const normalizedId = rawId.trim();

    if (!normalizedId) {
      return res.status(400).json(buildStructuredApiError(AGENT_ID_REQUIRED_ERROR_CODE));
    }

    if (/\s/.test(rawId)) {
      return res.status(400).json(buildStructuredApiError(AGENT_ID_CONTAINS_WHITESPACE_ERROR_CODE));
    }

    if (sessionManager.getSession(normalizedId)) {
      return res.status(400).json(buildStructuredApiError(AGENT_ID_ALREADY_EXISTS_ERROR_CODE, null, { agentId: normalizedId }));
    }

    // 外部运行时单聊：这个会话的 Agent 是本机的一个编码类外部运行时（Claude Code / Codex / …），
    // 不在 openclaw.json 里装配任何东西；续话句柄在这里生成。
    const externalRuntime = typeof req.body?.externalRuntime === 'string' ? req.body.externalRuntime.trim() : '';
    if (externalRuntime) {
      const registered = ctx.runtimePlatform.registry.get(externalRuntime);
      if (!registered || registered.descriptor.kind === 'remote') {
        return res.status(400).json(buildStructuredApiError('runtime.unknown', `Unknown external runtime: ${externalRuntime}`));
      }
      try {
        const session = sessionManager.createSession({
          id: normalizedId,
          agentId: normalizedId,
          name,
          external_runtime: externalRuntime,
          external_config: normalizeExternalSessionConfig(req.body?.externalConfig),
          external_session_id: randomUUID(),
        });
        ctx.sessionOrg.setOrigin(session.id, normalizeSessionOrigin(req.body?.origin));
        return res.json({ success: true, session });
      } catch (err: any) {
        return res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
      }
    }

    // Provide basic default for first session if it doesn't exist
    //
    // 这一步单独包一层 try：Express 4（backend/package.json 钉的 ^4.18.2）不会替
    // async handler 接管同步/异步抛错——如果 createSession() 留在下面那个大 try
    // 之外抛错，Express 4 既不会走 error middleware 也不会回一个响应，请求会一直
    // 悬挂到客户端超时，而不是拿到结构化的 400/500。装配失败的回滚逻辑（依赖
    // newSession 已经建好）留在下面第二层 try，不受影响。
    let newSession;
    try {
      newSession = sessionManager.createSession({
        id: normalizedId,
        name,
        process_start_tag,
        process_end_tag,
        runtime_mode: runtimeMode,
        system_prompt_mode: systemPromptMode,
        tool_mode: toolMode,
      });
    } catch (err: any) {
      return res.status(500).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
    }
    const agentId = newSession.id;

    try {
      // Provision agent workspace
      await agentProvisioner.provision({
        agentId,
        soulContent,
        userContent,
        agentsContent,
        toolsContent,
        heartbeatContent,
        identityContent,
        model,
        fallbackMode,
        fallbacks,
        systemPromptMode,
        toolMode,
      });

      // Update session record with the auto-generated agentId
      sessionManager.updateSession(newSession.id, { agentId });
      ctx.sessionOrg.setOrigin(newSession.id, normalizeSessionOrigin(req.body?.origin));
      const finalSession = sessionManager.getSession(newSession.id);

      res.json({ success: true, session: finalSession });
    } catch (err: any) {
      // provision() 失败要把上面刚建的 session 撤掉（同一个模式见 9989 行的角色包装配）。
      // 留着就是个孤儿 session：这个 ID 已经"存在"，用户改完配置重试会被 10029 行
      // 的 AGENT_ID_ALREADY_EXISTS 挡住，永远重试不了同一个 ID。
      // 红线 C：回滚本身也可能失败——裸 catch {} 会让这条静默吞掉，用户看到的仍是
      // "配置读不动"，真正卡住他的却是那条删不掉的孤儿行，日志里一点痕迹都没有。
      // 这里必须出声：打日志，并把这件事写进错误响应，让用户知道该换个 ID 而不是
      // 反复用同一个 ID 重试。
      let rollbackFailed = false;
      try {
        sessionManager.deleteSession(newSession.id);
      } catch (rollbackErr) {
        rollbackFailed = true;
        console.error('[POST /api/sessions] 回滚孤儿 session 失败，该 ID 已被锁死：', newSession.id, rollbackErr);
      }

      // ConfigReadError 是"配置读不动"，不是"装配失败"这一件笼统的事——给它自己的
      // errorCode，而不是把它的中文 message 塞进 MODEL_UPDATE_FAILED 的 detail 里，
      // 让前端和这里的测试都能在 errorCode 上分辨出这是哪一种失败。
      if (err instanceof ConfigReadError) {
        const detail = rollbackFailed
          ? `${err.reason}: ${err.detail}（该 ID 未能撤销，请换一个 ID 或手动清理）`
          : `${err.reason}: ${err.detail}`;
        return res.status(500).json(
          buildStructuredApiError(AGENT_CONFIG_READ_FAILED_ERROR_CODE, detail),
        );
      }
      const detail = rollbackFailed
        ? `${err?.message}（该 ID 未能撤销，请换一个 ID 或手动清理）`
        : err?.message;
      res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, detail));
    }
  });

  app.put('/api/sessions/:id', requireAdminAuth, async (req, res) => {
    const { name, soulContent, userContent, agentsContent, toolsContent, heartbeatContent, identityContent, model, process_start_tag, process_end_tag } = req.body;
    const fallbackMode = normalizeFallbackMode(req.body?.fallbackMode) ?? 'inherit';
    const fallbacks = normalizeFallbackList(req.body?.fallbacks);
    const runtimeMode = normalizeAgentRuntimeMode(req.body?.runtimeMode ?? req.body?.runtime_mode);
    const systemPromptMode = normalizeAgentSystemPromptMode(req.body?.systemPromptMode ?? req.body?.system_prompt_mode);
    const toolMode = normalizeAgentToolMode(req.body?.toolMode ?? req.body?.tool_mode);
    const session = sessionManager.getSession(req.params.id);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.external_runtime) {
      // 外部运行时会话只改名字与运行时配置（模式 / 模型 / 推理强度 / 工作目录）；没有 OpenClaw 侧的文件可写。
      const updated = sessionManager.updateSession(req.params.id, {
        name: typeof name === 'string' && name.trim() ? name : session.name,
        ...(req.body?.externalConfig !== undefined ? { external_config: normalizeExternalSessionConfig(req.body.externalConfig) } : {}),
      });
      return res.json({ success: true, session: updated });
    }

    try {
      const updated = sessionManager.updateSession(req.params.id, {
        name,
        process_start_tag,
        process_end_tag,
        runtime_mode: runtimeMode,
        system_prompt_mode: systemPromptMode,
        tool_mode: toolMode,
      });
      
      if (session.agentId) {
        await agentProvisioner.updateSoul(session.agentId, soulContent || '');
        if (userContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'USER.md', userContent);
        if (agentsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'AGENTS.md', agentsContent);
        if (toolsContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'TOOLS.md', toolsContent);
        if (heartbeatContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'HEARTBEAT.md', heartbeatContent);
        if (identityContent !== undefined) agentProvisioner.writeAgentFile(session.agentId, 'IDENTITY.md', identityContent);
        
        // Model update might require gateway restart
        const modelChanged = await agentProvisioner.updateModel(session.agentId, model, { mode: fallbackMode, fallbacks });
        agentProvisioner.updateAgentRuntimeConfig(session.agentId, { systemPromptMode, toolMode });
        if (modelChanged) {
          // Gateway auto-reloads config
        }
      }

      res.json({ success: true, session: updated });
    } catch (err: any) {
      res.status(400).json(buildStructuredApiError(MODEL_UPDATE_FAILED_ERROR_CODE, err?.message));
    }
  });

  type DeleteOutcome = { status: number; body: Record<string, unknown> };

  /**
   * 删一个单聊会话：停运行、清网关孤儿 run、断连接、删行（协调器通用表随之清）、回收运行时目录、撤销 Agent。
   * 单个删除与批量删除共用这一条路径——批量删不许走捷径漏掉任何一步。
   */
  async function deleteChatSession(sessionId: string): Promise<DeleteOutcome> {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return { status: 404, body: { success: false, error: 'Session not found' } };
    }

    if (session.id === 'main' || session.agentId === 'main') {
      return { status: 400, body: { success: false, error: 'Cannot delete the main agent session' } };
    }

    const agentId = session.agentId;
    const isExternalRuntimeSession = Boolean(session.external_runtime);
    const interruptedEpoch = getSessionInterruptionEpoch(sessionId);
    bumpSessionInterruptionEpoch(sessionId);
    localChatOperationManager.abort(sessionId, interruptedEpoch);
    try {
      await runCoordinator.abort(sessionId, 'user_stop');
    } catch {}
    if (!isExternalRuntimeSession) {
      try {
        const client = await getConnection(sessionId);
        await abortOpenClawSessionRuns(
          client,
          buildOpenClawChatSessionKey(sessionId, agentId || 'main'),
          `session ${sessionId} delete`,
          { retryOnMiss: true },
        );
      } catch (error) {
        console.warn(`[chat] Failed to abort orphan OpenClaw runs while deleting session ${sessionId}:`, error);
      }
    }
    disconnectConnection(sessionId);
    const success = sessionManager.deleteSession(sessionId);

    if (!success) {
      return { status: 404, body: { success: false, error: 'Session not found' } };
    }
    sessionInterruptionEpochs.delete(sessionId);
    // P2：这个会话在各外部运行时下的运行时目录一起回收（参考实现从不回收）。
    ctx.runtimePlatform.releaseOwner({ kind: 'session', sessionId });
    if (agentId && agentId !== 'main' && !isExternalRuntimeSession) {
      // deprovision() 现在会对「配置读不动」抛 ConfigReadError（原来是静默
      // `return false`，于是这条路由报 200 success 而配置条目、工作区、状态目录、
      // 记忆库一个都没删）。这里必须接住：此前**完全没有 try/catch**，
      // 一个异步抛错会变成未处理的 Promise 拒绝，请求悬着、进程可能被带崩。
      try {
        await agentProvisioner.deprovision(agentId);
      } catch (error) {
        if (error instanceof ConfigReadError) {
          // session 行已经删掉了，但 openclaw.json 里的条目还在——如实说出来，
          // 不要报成完全成功。用户需要知道去修配置，否则那个 agentId 再也建不回来。
          console.error(
            `[DELETE /api/sessions/:id] session 已删除，但清理 openclaw.json 失败（${error.reason}）：`,
            sessionId,
          );
          return {
            status: 500,
            body: buildStructuredApiError(AGENT_CONFIG_READ_FAILED_ERROR_CODE, error.detail, { reason: error.reason }),
          };
        }
        throw error;
      }
    }
    return { status: 200, body: { success: true } };
  }

  app.delete('/api/sessions/:id', requireAdminAuth, async (req, res) => {
    try {
      const outcome = await deleteChatSession(req.params.id);
      res.status(outcome.status).json(outcome.body);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error?.message || 'Failed to delete session' });
    }
  });

  /**
   * 批量删除（侧栏批量模式）。逐个走 `deleteChatSession`，一个失败不影响其余，结果如实报：
   * `{ deleted, failed, errors: [{ id, status, errorCode?, error? }] }`。删会话本身就是管理员的，
   * 这里仍逐个过会话可见性（与单个删除同一判据的上界：admin 全部可见，保留判定免得以后放宽闸门时漏掉）。
   */
  app.post('/api/sessions/batch-delete', requireAdminAuth, async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set((req.body.ids as unknown[]).map(String).filter(Boolean))] : null;
    if (!ids || ids.length === 0 || ids.length > 200) {
      return res.status(400).json(buildStructuredApiError('sessionOrg.errors.batchIdsInvalid'));
    }
    const identity = getRequestIdentity(req);
    const deleted: string[] = [];
    const errors: Array<{ id: string; status: number; errorCode?: string | null; error?: string | null }> = [];
    for (const id of ids) {
      if (!ctx.access.canAccessChatSession(identity, id)) {
        errors.push({ id, status: 403, errorCode: 'auth.agentForbidden' });
        continue;
      }
      try {
        const outcome = await deleteChatSession(id);
        if (outcome.status === 200) deleted.push(id);
        else errors.push({ id, status: outcome.status, errorCode: (outcome.body.errorCode as string) ?? null, error: (outcome.body.error as string) ?? null });
      } catch (error: any) {
        errors.push({ id, status: 500, error: error?.message || 'Failed to delete session' });
      }
    }
    res.json({ success: errors.length === 0, deleted, failed: errors.map((entry) => entry.id), errors });
  });

  // Reset session back to its initialized runtime state while keeping the session entity.
  app.post('/api/sessions/:id/reset', guardSessionId, async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    try {
      const agentId = session.agentId;
      const interruptedEpoch = getSessionInterruptionEpoch(req.params.id);
      bumpSessionInterruptionEpoch(req.params.id);
      localChatOperationManager.abort(req.params.id, interruptedEpoch);

      try {
        await runCoordinator.abort(req.params.id, 'user_stop');
      } catch {}
      try {
        const client = await getConnection(req.params.id);
        await abortOpenClawSessionRuns(
          client,
          buildOpenClawChatSessionKey(req.params.id, agentId || 'main'),
          `session ${req.params.id} reset`,
          { retryOnMiss: true },
        );
      } catch (error) {
        console.warn(`[chat] Failed to abort orphan OpenClaw runs while resetting session ${req.params.id}:`, error);
      }
      disconnectConnection(req.params.id);

      // Clear database records
      db.deleteMessagesBySession(req.params.id);
      // 历史清空了，从第一条消息推出来的标题也跟着作废（手动标题保留）。
      ctx.sessionOrg.clearGeneratedTitle(req.params.id);
      clearStoredFilesBySessionKey(req.params.id);

      // Clear agent workspace uploads directory
      if (agentId) {
        const workspacePath = agentProvisioner.getWorkspacePath(agentId);
        const modelConfig = agentProvisioner.readAgentModelConfig(agentId);
        const runtimeConfig = agentProvisioner.readAgentRuntimeConfig(agentId);
        resetAgentWorkspaceToInitialState(workspacePath);
        resetAgentRuntimeStateToInitialState(agentId);
        await agentProvisioner.provision({
          agentId,
          workspaceDir: workspacePath,
          model: modelConfig.modelOverride || undefined,
          fallbackMode: modelConfig.fallbackMode,
          fallbacks: modelConfig.fallbacks,
          systemPromptMode: runtimeConfig.systemPromptMode,
          toolMode: runtimeConfig.toolMode,
          // 重置要保住运行时选择。不带这一项的话，重置一个跑在 Claude Code 上的
          // Agent 会把它悄悄变回引擎默认——用户看到的是「重置了一下就不工作了」，
          // 而没有任何东西指向真实原因。
        });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Failed to reset session:', err);
      res.status(500).json({ success: false, error: 'Failed to reset session' });
    }
  });

  // Endpoint to fetch all configuring MD files for a given session's agent
  app.get('/api/sessions/:id/configs', guardSessionId, async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const agentId = session.agentId;
    // 配置读不动时退回"没配模型"的旧降级形状，不让这条详情页整体 500——
    // 界面上其余六份 markdown 内容依然是真实数据，不该因为模型标签读不到就全部拿不到。
    const { value: modelConfig, configReadFailed: modelReadFailed } = withConfigReadFallback(
      { model: null, modelOverride: null, fallbackMode: 'inherit' as const, fallbacks: [] as string[], resolvedModel: null },
      () => agentProvisioner.readAgentModelConfig(agentId),
    );
    const { value: runtimeSettings, configReadFailed: runtimeReadFailed } = withConfigReadFallback(
      { runtimeMode: normalizeAgentRuntimeMode(session.runtime_mode), ...RUNTIME_SETTINGS_CONFIG_READ_FALLBACK },
      () => readEffectiveAgentRuntimeSettings(session, agentId),
    );
    const configReadFailed = modelReadFailed || runtimeReadFailed;
    const runtimeMetrics = agentProvisioner.readAgentRuntimeMetrics(agentId);
    res.json({
      success: true,
      configs: {
        soulContent: agentProvisioner.readSoul(agentId) || '',
        userContent: agentProvisioner.readAgentFile(agentId, 'USER.md', ''),
        agentsContent: agentProvisioner.readAgentFile(agentId, 'AGENTS.md', ''),
        toolsContent: agentProvisioner.readAgentFile(agentId, 'TOOLS.md', ''),
        heartbeatContent: agentProvisioner.readAgentFile(agentId, 'HEARTBEAT.md', ''),
        identityContent: agentProvisioner.readAgentFile(agentId, 'IDENTITY.md', ''),
        model: modelConfig.model,
        modelOverride: modelConfig.modelOverride,
        resolvedModel: modelConfig.resolvedModel,
        fallbackMode: modelConfig.fallbackMode,
        fallbacks: modelConfig.fallbacks,
        runtimeMode: runtimeSettings.runtimeMode,
        systemPromptMode: runtimeSettings.systemPromptMode,
        toolMode: runtimeSettings.toolMode,
        runtimeMetrics,
        configReadFailed,
      }
    });
  });

  app.post('/api/sessions/reorder', (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ success: false, error: 'Invalid ids format' });
    }
    const identity = getRequestIdentity(req);
    if (!ids.every((id) => ctx.access.canAccessChatSession(identity, String(id)))) return sendResourceForbidden(res);
    sessionManager.reorderSessions(ids);
    res.json({ success: true });
  });

  app.get('/api/history/:sessionId', guardSessionParam, async (req, res) => {
    try {
      const { beforeId, limit } = getHistoryPageQueryParams(req.query as Record<string, unknown>);
      if (beforeId === null) {
        await reconcileInactiveChatLatestMessage(req.params.sessionId);
      }
      const result = db.getMessagesPage(req.params.sessionId, { beforeId, limit });
      res.json(buildHistoryPageResponse(
        result.rows.map((row) => withStructuredChatMessage(row, { sessionId: req.params.sessionId })),
        result.pageInfo,
      ));
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/history/:sessionId/search', guardSessionParam, (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      res.json(buildHistorySearchResponse(db.searchMessages(req.params.sessionId, query)));
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/chat/:sessionId/active-run', guardSessionParam, async (req, res) => {
    try {
      const { sessionId } = req.params;
      const run = runCoordinator.getActiveRun(sessionId);
      const localOperation = localChatOperationManager.get(sessionId);
      if (!run && !localOperation) {
        await reconcileInactiveChatLatestMessage(sessionId);
      }
      const active = !!(run || localOperation);
      // 协调器里的网关运行：准备阶段还没有网关 run id（与迁移前的 openclaw-preparation 一致）。
      const runMessageId = typeof run?.meta.messageId === 'number' ? run.meta.messageId : null;
      res.json({
        success: true,
        active,
        runState: {
          active,
          messageId: runMessageId ?? localOperation?.messageId ?? null,
          runId: run?.phase === 'running' ? run.nativeRunId ?? null : null,
          agentId: run?.agentId ?? localOperation?.agentId ?? null,
          startedAt: run?.startedAt ?? localOperation?.startedAt ?? null,
          kind: localOperation?.kind ?? (run ? (run.phase === 'preparing' ? 'openclaw-preparation' : 'openclaw-run') : null),
        },
      });
    } catch (error: any) {
      res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to read chat run state.'));
    }
  });

  /** 按消息 id 改 / 删：先找到它属于哪个会话再判授权。没有这条消息时 member 同样 403（不泄露存在性）。 */
  const guardMessageId: express.RequestHandler = (req, res, next) => {
    const sessionKey = db.getMessageSessionKey(Number(req.params.id));
    const identity = getRequestIdentity(req);
    if (sessionKey !== null ? ctx.access.canAccessChatSession(identity, sessionKey) : ctx.access.isAdmin(identity)) return next();
    return sendResourceForbidden(res);
  };

  app.put('/api/messages/:id', guardMessageId, (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    if (!content) return res.status(400).json({ success: false, error: 'Content is required' });
    try {
      db.updateMessageContent(Number(id), content);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/messages/:id', guardMessageId, (req, res) => {
    const { id } = req.params;
    try {
      const deletedIds = db.deleteMessage(Number(id));
      res.json({ success: true, deletedIds });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
