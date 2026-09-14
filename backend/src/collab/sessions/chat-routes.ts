import path from 'path';

import {
  type AgentProvisioner,
  type AgentSettings,
  buildHostTakeoverChatInstruction,
  type ImageGenerationService,
  resolveModelTagForErrorReport,
  shouldUseConfiguredImageGenerationModel,
} from '../../control';
import type { DB } from '../../core/db';
import type { RouteApp } from '../../core/http';
import { type GatewayConnections, OpenClawClient } from '../../openclaw';
import type { UploadService } from '../../workspace';
import type { ChatRuns } from './active-run-manager';
import { type ChatCommands, parseChatCommand } from './chat-commands';
import {
  CHAT_HISTORY_COMPLETION_PROBE_LIMIT,
  CHAT_LATEST_ROUND_ONLY_CODE,
  CHAT_LATEST_ROUND_ONLY_DETAIL,
  CHAT_ORPHAN_ABORT_TIMEOUT_MS,
} from './chat-constants';
import { getHistorySnapshot, getUnknownHistorySnapshot } from './chat-history-reconciliation';
import {
  abortOpenClawSessionRuns,
  type ChatLifecycle,
  scheduleOpenClawSessionAbortRetry,
} from './chat-lifecycle';
import {
  buildStructuredChatErrorStreamEvent,
  buildStructuredChatHttpError,
  createStructuredChatError,
  resolveStructuredChatErrorInput,
} from './chat-messages';
import { isStreamingClientOpen } from './chat-run-managers';
import type { DirectChatService } from './direct-chat-service';
import { rewriteOpenClawMediaPaths } from './process-text';
import type { SessionManager } from './session-manager';
import {
  buildOpenClawChatSessionKey,
  SessionInterruptedError,
  type SessionRuntime,
} from './session-runtime';

export type ChatRoutesDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  sessionManager: SessionManager;
  chatRuns: ChatRuns;
  chatCommands: ChatCommands;
  chatLifecycle: ChatLifecycle;
  directChat: DirectChatService;
  sessionRuntime: SessionRuntime;
  agentSettings: AgentSettings;
  imageGeneration: ImageGenerationService;
  gatewayConnections: GatewayConnections;
  uploads: UploadService;
};

export function registerChatRoutes(app: RouteApp, ctx: ChatRoutesDeps): void {
  const { agentProvisioner, db, sessionManager } = ctx;
  const { activeRunManager, localChatOperationManager, pendingChatPreparationManager } = ctx.chatRuns;
  const { resolveChatCommandResult } = ctx.chatCommands;
  const { getLatestChatRegenerateTarget, interruptSessionStreamingStateForNewRun, reconcileInactiveChatLatestMessage } = ctx.chatLifecycle;
  const { prepareOutgoingMessage, runDirectChatCompletion } = ctx.directChat;
  const { assertSessionInterruptionEpoch, bumpSessionInterruptionEpoch, getSessionInterruptionEpoch, getSessionWorkspacePath, readAgentBootstrapIntentContext } = ctx.sessionRuntime;
  const { readEffectiveAgentRuntimeSettings, shouldInjectHostTakeoverInstruction } = ctx.agentSettings;
  const { buildImageGenerationStartProcessContent, getConfiguredDirectImageGenerationModel, tryGenerateImageForPrompt } = ctx.imageGeneration;
  const { getConnection } = ctx.gatewayConnections;
  const { clearStoredFilesBySessionKey } = ctx.uploads;

  app.post('/api/chat', async (req, res) => {
    const { sessionId, message, parentId } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId or message'));
    }

    const normalizedSessionId = String(sessionId);
    const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

    let userMsgId: number | undefined;
    let assistantMsgId: number | undefined;
    let pendingPreparationActive = false;
    let sessionEventsClient: OpenClawClient | null = null;
    let sessionEventsSubscribed = false;

    try {
      const rawMessage = String(message);
      const parsedCommand = parseChatCommand(rawMessage);
      const sessionInfo = sessionManager.getSession(normalizedSessionId);
      let finalMessage = rawMessage;
      let injectedInstructions = '';

      const agentId = sessionInfo?.agentId || 'main';
      const runtimeSettings = readEffectiveAgentRuntimeSettings(sessionInfo, agentId);
      const allCharacters = db.getCharacters();
      const character = allCharacters.find(c => c.agentId === agentId);
      const agentName = sessionInfo?.name || character?.name || agentId;
      const imageIntentContext = readAgentBootstrapIntentContext(agentId);
      const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
        ? getConfiguredDirectImageGenerationModel()
        : null;
      const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
        agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

      if (sessionInfo) {
        if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
          injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
        }
      }
      if (shouldInjectHostTakeoverInstruction(sessionInfo, agentId)) {
        injectedInstructions += `${buildHostTakeoverChatInstruction()}\n\n`;
      }

      if (injectedInstructions) {
        finalMessage = `${injectedInstructions}${finalMessage}`;
      }

      if (parsedCommand) {
        const commandResult = await resolveChatCommandResult(parsedCommand, normalizedSessionId);
        if (commandResult) {
          if (commandResult.clearBeforeSave) {
            db.deleteMessagesBySession(normalizedSessionId);
            clearStoredFilesBySessionKey(normalizedSessionId);
          }

          let finalParentId = parentId ? Number(parentId) : undefined;
          if (finalParentId === undefined) {
            const history = db.getMessages(normalizedSessionId, 1);
            finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
          }

          userMsgId = Number(db.saveMessage({
            session_key: normalizedSessionId,
            parent_id: finalParentId,
            role: 'user',
            content: rawMessage,
          }));

          assistantMsgId = Number(db.saveMessage({
            session_key: normalizedSessionId,
            parent_id: userMsgId,
            role: 'assistant',
            content: commandResult.content,
            model_used: modelUsed,
            agent_id: agentId,
            agent_name: agentName,
          }));

          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
          res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
          res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId, assistantMsgId })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: 'final', text: commandResult.content })}\n\n`);
          res.end();
          return;
        }

        // Unknown slash command falls back to normal chat flow.
      }

      let finalParentId = parentId ? Number(parentId) : undefined;
      if (finalParentId === undefined) {
        const history = db.getMessages(normalizedSessionId, 1);
        finalParentId = history.length > 0 ? history[history.length - 1].id : undefined;
      }

      userMsgId = Number(db.saveMessage({ session_key: normalizedSessionId, parent_id: finalParentId, role: 'user', content: rawMessage }));

      assistantMsgId = Number(db.saveMessage({
        session_key: normalizedSessionId,
        parent_id: userMsgId,
        role: 'assistant',
        content: '', // empty initially
        model_used: modelUsed,
        agent_id: agentId,
        agent_name: agentName
      }));

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Notify frontend of the real DB IDs immediately
      res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
      res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId, assistantMsgId })}\n\n`);

      if (directImageModel) {
        const localImageController = new AbortController();
        const startProcessContent = buildImageGenerationStartProcessContent(directImageModel);
        db.updateMessage(assistantMsgId, '', directImageModel, startProcessContent, true);
        localChatOperationManager.start({
          sessionId: normalizedSessionId,
          epoch: sessionInterruptionEpoch,
          messageId: assistantMsgId,
          agentId,
          agentName,
          modelUsed: directImageModel,
          startedAt: Date.now(),
          kind: 'image-generation',
          abortController: localImageController,
        });
        const startEvent = {
          type: 'delta',
          text: '',
          process_content: startProcessContent,
          process_streaming: true,
          modelUsed: directImageModel,
          model_used: directImageModel,
        };
        if (isStreamingClientOpen(res)) {
          try {
            res.write(`data: ${JSON.stringify(startEvent)}\n\n`);
          } catch {}
        }

        const directImageResult = await tryGenerateImageForPrompt({
          prompt: rawMessage,
          intentText: rawMessage,
          intentContext: imageIntentContext,
          outputDir: path.join(getSessionWorkspacePath(normalizedSessionId), 'output', 'image-generations'),
          signal: localImageController.signal,
        });
        if (directImageResult) {
          assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
          db.updateMessage(assistantMsgId, directImageResult.content, directImageResult.modelUsed, directImageResult.processContent, false);
          const finalEvent = {
            type: 'final',
            text: directImageResult.content,
            process_content: directImageResult.processContent,
            process_streaming: false,
            modelUsed: directImageResult.modelUsed,
            model_used: directImageResult.modelUsed,
          };
          if (isStreamingClientOpen(res)) {
            try {
              res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
              res.end();
            } catch {}
          }
          localChatOperationManager.emit(normalizedSessionId, finalEvent, sessionInterruptionEpoch);
          localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
          return;
        }
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
      }

      if (runtimeSettings.runtimeMode === 'direct') {
        const localDirectController = new AbortController();
        localChatOperationManager.start({
          sessionId: normalizedSessionId,
          epoch: sessionInterruptionEpoch,
          messageId: assistantMsgId,
          agentId,
          agentName,
          modelUsed,
          startedAt: Date.now(),
          kind: 'direct-runtime',
          abortController: localDirectController,
        });
        await runDirectChatCompletion({
          sessionId: normalizedSessionId,
          agentId,
          userMessageId: userMsgId,
          assistantMessageId: assistantMsgId,
          message: finalMessage,
          modelUsed,
          response: res,
          signal: localDirectController.signal,
          onEvent: (event) => localChatOperationManager.emit(normalizedSessionId, event, sessionInterruptionEpoch),
          processStartTag: sessionInfo?.process_start_tag || undefined,
          processEndTag: sessionInfo?.process_end_tag || undefined,
          sessionInterruptionEpoch,
        });
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
        return;
      }

      pendingChatPreparationManager.start({
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        messageId: assistantMsgId,
        agentId,
        agentName,
        modelUsed,
        startedAt: Date.now(),
      });
      pendingPreparationActive = true;
      pendingChatPreparationManager.attachClient(normalizedSessionId, res, {
        announceAttach: true,
        expectedEpoch: sessionInterruptionEpoch,
      });

      const client = await getConnection(normalizedSessionId);
      sessionEventsClient = client;
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
      const expectedSessionKey = buildOpenClawChatSessionKey(normalizedSessionId, agentId);
      await abortOpenClawSessionRuns(client, expectedSessionKey, `session ${normalizedSessionId} before send`);
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
      try {
        await client.subscribeSessionEvents();
        sessionEventsSubscribed = true;
      } catch (error) {
        console.warn(`[chat] Failed to subscribe session events for session ${normalizedSessionId}:`, error);
      }
      const outgoingMessage = await prepareOutgoingMessage(finalMessage, agentId, {
        includeDocumentToolingContext: runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding',
      });
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

      const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT)
        .then((history) => getHistorySnapshot(history))
        .catch(() => getUnknownHistorySnapshot());
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

      const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
        sessionKey: normalizedSessionId,
        message: outgoingMessage.text,
        agentId: agentId,
        attachments: outgoingMessage.attachments,
      });
      if (getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch) {
        try {
          const abortResult = await client.abortChat({
            sessionKey: finalSessionKey,
            runId,
            timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
          });
          if (!abortResult.aborted) {
            scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
          }
        } catch {
          scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
        }
        throw new SessionInterruptedError(normalizedSessionId);
      }

      const run = activeRunManager.startRun(
        normalizedSessionId,
        runId,
        agentId,
        agentName,
        modelUsed,
        assistantMsgId,
        getSessionWorkspacePath(normalizedSessionId),
        client,
        finalSessionKey,
        preRunHistorySnapshot,
        sessionInfo?.process_start_tag || undefined,
        sessionInfo?.process_end_tag || undefined,
        sessionEventsSubscribed
      );
      sessionEventsSubscribed = false;
      const pendingClients = pendingChatPreparationManager.promoteClients(normalizedSessionId, sessionInterruptionEpoch);
      pendingPreparationActive = false;
      pendingClients.forEach((clientRes) => {
        activeRunManager.attachClient(normalizedSessionId, clientRes);
      });

    } catch (error: any) {
      if (sessionEventsSubscribed && sessionEventsClient) {
        sessionEventsSubscribed = false;
        void sessionEventsClient.unsubscribeSessionEvents().catch((unsubscribeError) => {
          console.warn(`[chat] Failed to unsubscribe session events for session ${normalizedSessionId}:`, unsubscribeError);
        });
      }
      const resetInterrupted = error instanceof SessionInterruptedError || getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch;
      if (resetInterrupted) {
        if (pendingPreparationActive) {
          if (typeof assistantMsgId === 'number') {
            try {
              db.deleteMessage(assistantMsgId);
              assistantMsgId = undefined;
            } catch {}
          }
          pendingChatPreparationManager.cancel(normalizedSessionId, sessionInterruptionEpoch);
          pendingPreparationActive = false;
        } else if (res.headersSent) {
          try {
            res.end();
          } catch {}
        } else {
          res.status(409).json(buildStructuredChatHttpError('Session was interrupted during processing.'));
        }
        return;
      }

      const structuredErrorInput = resolveStructuredChatErrorInput(error);
      const structuredError = createStructuredChatError(
        structuredErrorInput.rawDetail,
        structuredErrorInput.messageCode
      );
      const sessionInfo = db.getSession(normalizedSessionId);
      const agentId = sessionInfo?.agentId || 'main';
      const character = db.getCharacters().find(c => c.agentId === agentId);
      const modelUsed = resolveModelTagForErrorReport(agentProvisioner, agentId);

      if (typeof assistantMsgId === 'number') {
        try {
          db.updateMessage(assistantMsgId, structuredError.content, modelUsed, null, false);
          db.updateMessageEnvelope(assistantMsgId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
        } catch {}
      } else if (typeof userMsgId === 'number') {
        try {
          assistantMsgId = Number(db.saveMessage({
            session_key: normalizedSessionId,
            parent_id: userMsgId,
            role: structuredError.role,
            content: structuredError.content,
            model_used: modelUsed,
            agent_id: structuredError.agent_id,
            agent_name: structuredError.agent_name,
          }));
        } catch {}
      }

      if (!res.headersSent) {
        res.status(500).json(buildStructuredChatHttpError(
          structuredErrorInput.rawDetail,
          structuredErrorInput.messageCode
        ));
      } else {
        if (pendingPreparationActive) {
          pendingChatPreparationManager.fail(normalizedSessionId, structuredError, sessionInterruptionEpoch);
          pendingPreparationActive = false;
        } else {
          const errorEvent = buildStructuredChatErrorStreamEvent(structuredError);
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          localChatOperationManager.emit(normalizedSessionId, errorEvent, sessionInterruptionEpoch);
          localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
          res.end();
        }
      }
    }
  });

  app.post('/api/chat/regenerate', async (req, res) => {
    const { sessionId, message, parentId, targetMessageId } = req.body;

    if (!sessionId || !message || !parentId) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId, message, or parentId'));
    }

    const normalizedSessionId = String(sessionId);
    const sessionInterruptionEpoch = await interruptSessionStreamingStateForNewRun(normalizedSessionId);

    let assistantMsgId: number | undefined;
    let pendingPreparationActive = false;
    let sessionEventsClient: OpenClawClient | null = null;
    let sessionEventsSubscribed = false;

    try {
      const requestedParentId = Number(parentId);
      const requestedTargetMessageId = Number(targetMessageId);
      const { latestUserMessage, latestReplyMessage } = getLatestChatRegenerateTarget(normalizedSessionId);
      const latestUserId = Number(latestUserMessage?.id);
      const latestReplyId = Number(latestReplyMessage?.id);
      const latestReplyParentId = Number(latestReplyMessage?.parent_id);
      const latestRoundTargetIds = new Set<number>();
      if (Number.isFinite(latestUserId)) {
        latestRoundTargetIds.add(latestUserId);
      }
      if (Number.isFinite(latestReplyId)) {
        latestRoundTargetIds.add(latestReplyId);
      }

      const requestReferencesLatestRound = [requestedParentId, requestedTargetMessageId].some((candidateId) => (
        Number.isFinite(candidateId) && latestRoundTargetIds.has(candidateId)
      ));
      const numericParentId = latestUserId;

      if (
        !Number.isFinite(numericParentId)
        || !latestUserMessage
        || !requestReferencesLatestRound
      ) {
        return res.status(409).json(buildStructuredChatHttpError(
          CHAT_LATEST_ROUND_ONLY_DETAIL,
          CHAT_LATEST_ROUND_ONLY_CODE,
        ));
      }

      if (
        latestReplyMessage
        && (latestReplyMessage.role === 'assistant' || latestReplyMessage.role === 'system')
        && latestReplyParentId === numericParentId
        && typeof latestReplyMessage.id === 'number'
      ) {
        db.deleteMessage(Number(latestReplyMessage.id));
      }

      const sessionInfo = sessionManager.getSession(normalizedSessionId);
      const rawMessage = String(message);
      let finalMessage = rawMessage;
      let injectedInstructions = '';

      if (sessionInfo) {
        if (sessionInfo.process_start_tag && sessionInfo.process_end_tag) {
          injectedInstructions += `【极其重要：输出格式规范】\n当前启用了结构化思考输出。你关于后续任务决断的所有内部思考、分析或工作执行过程，必须严格包裹在 ${sessionInfo.process_start_tag} 和 ${sessionInfo.process_end_tag} 之间！\n真正的最终沟通、回复语言写在标签外部。\n\n`;
        }
      }
      const agentId = sessionInfo?.agentId || 'main';
      const runtimeSettings = readEffectiveAgentRuntimeSettings(sessionInfo, agentId);

      if (shouldInjectHostTakeoverInstruction(sessionInfo, agentId)) {
        injectedInstructions += `${buildHostTakeoverChatInstruction()}\n\n`;
      }

      if (injectedInstructions) {
        finalMessage = `${injectedInstructions}${finalMessage}`;
      }

      const allCharacters = db.getCharacters();
      const character = allCharacters.find(c => c.agentId === agentId);
      const agentName = sessionInfo?.name || character?.name || agentId;
      const imageIntentContext = readAgentBootstrapIntentContext(agentId);
      const directImageModel = shouldUseConfiguredImageGenerationModel(rawMessage, imageIntentContext)
        ? getConfiguredDirectImageGenerationModel()
        : null;
      const modelUsed = directImageModel || agentProvisioner.readAgentModel(agentId) ||
        agentProvisioner.readAvailableModels().find(m => m.primary)?.id || '';

      assistantMsgId = Number(db.saveMessage({
        session_key: normalizedSessionId,
        parent_id: numericParentId,
        role: 'assistant',
        content: '', 
        model_used: modelUsed,
        agent_id: agentId,
        agent_name: agentName
      }));

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Notify frontend immediately of the new assistant msg ID
      res.write(':' + Array(2048).fill(' ').join('') + '\n\n');
      res.write(`data: ${JSON.stringify({ type: 'ids', userMsgId: numericParentId, assistantMsgId })}\n\n`);

      if (directImageModel) {
        const localImageController = new AbortController();
        const startProcessContent = buildImageGenerationStartProcessContent(directImageModel);
        db.updateMessage(assistantMsgId, '', directImageModel, startProcessContent, true);
        localChatOperationManager.start({
          sessionId: normalizedSessionId,
          epoch: sessionInterruptionEpoch,
          messageId: assistantMsgId,
          agentId,
          agentName,
          modelUsed: directImageModel,
          startedAt: Date.now(),
          kind: 'image-generation',
          abortController: localImageController,
        });
        const startEvent = {
          type: 'delta',
          text: '',
          process_content: startProcessContent,
          process_streaming: true,
          modelUsed: directImageModel,
          model_used: directImageModel,
        };
        if (isStreamingClientOpen(res)) {
          try {
            res.write(`data: ${JSON.stringify(startEvent)}\n\n`);
          } catch {}
        }

        const directImageResult = await tryGenerateImageForPrompt({
          prompt: rawMessage,
          intentText: rawMessage,
          intentContext: imageIntentContext,
          outputDir: path.join(getSessionWorkspacePath(normalizedSessionId), 'output', 'image-generations'),
          signal: localImageController.signal,
        });
        if (directImageResult) {
          assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
          db.updateMessage(assistantMsgId, directImageResult.content, directImageResult.modelUsed, directImageResult.processContent, false);
          const finalEvent = {
            type: 'final',
            text: directImageResult.content,
            process_content: directImageResult.processContent,
            process_streaming: false,
            modelUsed: directImageResult.modelUsed,
            model_used: directImageResult.modelUsed,
          };
          if (isStreamingClientOpen(res)) {
            try {
              res.write(`data: ${JSON.stringify(finalEvent)}\n\n`);
              res.end();
            } catch {}
          }
          localChatOperationManager.emit(normalizedSessionId, finalEvent, sessionInterruptionEpoch);
          localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
          return;
        }
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
      }

      if (runtimeSettings.runtimeMode === 'direct') {
        const localDirectController = new AbortController();
        localChatOperationManager.start({
          sessionId: normalizedSessionId,
          epoch: sessionInterruptionEpoch,
          messageId: assistantMsgId,
          agentId,
          agentName,
          modelUsed,
          startedAt: Date.now(),
          kind: 'direct-runtime',
          abortController: localDirectController,
        });
        await runDirectChatCompletion({
          sessionId: normalizedSessionId,
          agentId,
          userMessageId: numericParentId,
          assistantMessageId: assistantMsgId,
          message: finalMessage,
          modelUsed,
          response: res,
          signal: localDirectController.signal,
          onEvent: (event) => localChatOperationManager.emit(normalizedSessionId, event, sessionInterruptionEpoch),
          processStartTag: sessionInfo?.process_start_tag || undefined,
          processEndTag: sessionInfo?.process_end_tag || undefined,
          sessionInterruptionEpoch,
        });
        localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
        return;
      }

      pendingChatPreparationManager.start({
        sessionId: normalizedSessionId,
        epoch: sessionInterruptionEpoch,
        messageId: assistantMsgId,
        agentId,
        agentName,
        modelUsed,
        startedAt: Date.now(),
      });
      pendingPreparationActive = true;
      pendingChatPreparationManager.attachClient(normalizedSessionId, res, {
        announceAttach: true,
        expectedEpoch: sessionInterruptionEpoch,
      });

      const client = await getConnection(normalizedSessionId);
      sessionEventsClient = client;
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
      const expectedSessionKey = buildOpenClawChatSessionKey(normalizedSessionId, agentId);
      await abortOpenClawSessionRuns(client, expectedSessionKey, `session ${normalizedSessionId} before regenerate`);
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);
      try {
        await client.subscribeSessionEvents();
        sessionEventsSubscribed = true;
      } catch (error) {
        console.warn(`[chat] Failed to subscribe session events for session ${normalizedSessionId}:`, error);
      }
      const outgoingMessage = await prepareOutgoingMessage(finalMessage, agentId, {
        includeDocumentToolingContext: runtimeSettings.toolMode === 'full' || runtimeSettings.toolMode === 'coding',
      });
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

      const preRunHistorySnapshot = await client.getChatHistory(expectedSessionKey, CHAT_HISTORY_COMPLETION_PROBE_LIMIT)
        .then((history) => getHistorySnapshot(history))
        .catch(() => getUnknownHistorySnapshot());
      assertSessionInterruptionEpoch(normalizedSessionId, sessionInterruptionEpoch);

      const { runId, sessionKey: finalSessionKey } = await client.sendChatMessageStreaming({
        sessionKey: normalizedSessionId,
        message: outgoingMessage.text,
        agentId: agentId,
        attachments: outgoingMessage.attachments,
      });
      if (getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch) {
        try {
          const abortResult = await client.abortChat({
            sessionKey: finalSessionKey,
            runId,
            timeoutMs: CHAT_ORPHAN_ABORT_TIMEOUT_MS,
          });
          if (!abortResult.aborted) {
            scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
          }
        } catch {
          scheduleOpenClawSessionAbortRetry(client, finalSessionKey, `interrupted session ${normalizedSessionId}`);
        }
        throw new SessionInterruptedError(normalizedSessionId);
      }

      const run = activeRunManager.startRun(
        normalizedSessionId,
        runId,
        agentId,
        agentName,
        modelUsed,
        assistantMsgId,
        getSessionWorkspacePath(normalizedSessionId),
        client,
        finalSessionKey,
        preRunHistorySnapshot,
        sessionInfo?.process_start_tag || undefined,
        sessionInfo?.process_end_tag || undefined,
        sessionEventsSubscribed
      );
      sessionEventsSubscribed = false;

      const pendingClients = pendingChatPreparationManager.promoteClients(normalizedSessionId, sessionInterruptionEpoch);
      pendingPreparationActive = false;
      pendingClients.forEach((clientRes) => {
        activeRunManager.attachClient(normalizedSessionId, clientRes);
      });

    } catch (error: any) {
      if (sessionEventsSubscribed && sessionEventsClient) {
        sessionEventsSubscribed = false;
        void sessionEventsClient.unsubscribeSessionEvents().catch((unsubscribeError) => {
          console.warn(`[chat] Failed to unsubscribe session events for session ${normalizedSessionId}:`, unsubscribeError);
        });
      }
      const resetInterrupted = error instanceof SessionInterruptedError || getSessionInterruptionEpoch(normalizedSessionId) !== sessionInterruptionEpoch;
      if (resetInterrupted) {
        if (pendingPreparationActive) {
          if (typeof assistantMsgId === 'number') {
            try {
              db.deleteMessage(assistantMsgId);
              assistantMsgId = undefined;
            } catch {}
          }
          pendingChatPreparationManager.cancel(normalizedSessionId, sessionInterruptionEpoch);
          pendingPreparationActive = false;
        } else if (res.headersSent) {
          try {
            res.end();
          } catch {}
        } else {
          res.status(409).json(buildStructuredChatHttpError('Session was interrupted during processing.'));
        }
        return;
      }

      const structuredErrorInput = resolveStructuredChatErrorInput(error);
      const structuredError = createStructuredChatError(
        structuredErrorInput.rawDetail,
        structuredErrorInput.messageCode
      );
      const sessionInfo = db.getSession(normalizedSessionId);
      const agentId = sessionInfo?.agentId || 'main';
      const modelUsed = resolveModelTagForErrorReport(agentProvisioner, agentId);

      if (typeof assistantMsgId === 'number') {
        try {
          db.updateMessage(assistantMsgId, structuredError.content, modelUsed, null, false);
          db.updateMessageEnvelope(assistantMsgId, structuredError.role, structuredError.agent_id, structuredError.agent_name);
        } catch {}
      } else {
        try {
          assistantMsgId = Number(db.saveMessage({
            session_key: normalizedSessionId,
            parent_id: Number(parentId),
            role: structuredError.role,
            content: structuredError.content,
            model_used: modelUsed,
            agent_id: structuredError.agent_id,
            agent_name: structuredError.agent_name,
          }));
        } catch {}
      }

      if (!res.headersSent) {
        res.status(500).json(buildStructuredChatHttpError(
          structuredErrorInput.rawDetail,
          structuredErrorInput.messageCode
        ));
      } else {
        if (pendingPreparationActive) {
          pendingChatPreparationManager.fail(normalizedSessionId, structuredError, sessionInterruptionEpoch);
          pendingPreparationActive = false;
        } else {
          const errorEvent = buildStructuredChatErrorStreamEvent(structuredError);
          res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
          localChatOperationManager.emit(normalizedSessionId, errorEvent, sessionInterruptionEpoch);
          localChatOperationManager.finish(normalizedSessionId, sessionInterruptionEpoch);
          res.end();
        }
      }
    }
  });

  app.get('/api/chat/attach/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const pendingPreparation = pendingChatPreparationManager.get(sessionId);
      const run = activeRunManager.getRun(sessionId);
      const localOperation = localChatOperationManager.get(sessionId);
      if (!run && !pendingPreparation && !localOperation) {
        await reconcileInactiveChatLatestMessage(sessionId);
        // Return empty payload to indicate no active run
        return res.status(200).json({ active: false });
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      if (run) {
        activeRunManager.attachClient(sessionId, res, { announceAttach: true });
        return;
      }

      if (localOperation) {
        localChatOperationManager.attachClient(sessionId, res, { announceAttach: true });
        return;
      }

      pendingChatPreparationManager.attachClient(sessionId, res, { announceAttach: true });
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to attach chat stream.'));
        return;
      }
      try {
        res.end();
      } catch {}
    }
  });

  app.post('/api/chat/stop', async (req, res) => {
    const { sessionId } = req.body || {};

    if (!sessionId) {
      return res.status(400).json(buildStructuredChatHttpError('Missing sessionId'));
    }

    try {
      const normalizedSessionId = String(sessionId);
      const interruptedEpoch = getSessionInterruptionEpoch(normalizedSessionId);
      bumpSessionInterruptionEpoch(normalizedSessionId);
      pendingChatPreparationManager.cancel(normalizedSessionId, interruptedEpoch);
      const localAbortResult = localChatOperationManager.abort(normalizedSessionId, interruptedEpoch);
      const result = await activeRunManager.abortRun(normalizedSessionId);
      let orphanAbortResult: { aborted: boolean; runIds: string[] } = { aborted: false, runIds: [] };
      try {
        const sessionInfo = sessionManager.getSession(normalizedSessionId);
        const agentId = sessionInfo?.agentId || 'main';
        const client = await getConnection(normalizedSessionId);
        orphanAbortResult = await abortOpenClawSessionRuns(
          client,
          buildOpenClawChatSessionKey(normalizedSessionId, agentId),
          `session ${normalizedSessionId} stop`,
          { retryOnMiss: true },
        );
      } catch (error) {
        console.warn(`[chat] Failed to abort orphan OpenClaw runs while stopping session ${normalizedSessionId}:`, error);
      }
      await reconcileInactiveChatLatestMessage(normalizedSessionId);
      res.json({
        success: true,
        aborted: localAbortResult.aborted || result.aborted || orphanAbortResult.aborted,
        runIds: orphanAbortResult.runIds,
      });
    } catch (error: any) {
      res.status(500).json(buildStructuredChatHttpError(error?.message || 'Failed to stop chat run.'));
    }
  });

  app.post('/api/chat/silent', async (req, res) => {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'Missing sessionId or message' });
    }

    try {
      const client = await getConnection(sessionId);
      const rawResponse = await client.sendChatMessage({ sessionKey: sessionId, message });
      // Rewrite absolute OpenClaw media paths to HTTP-accessible URLs
      const response = rewriteOpenClawMediaPaths(rawResponse, getSessionWorkspacePath(sessionId));
      // Note: We intentionally DO NOT save to DB here
      res.json({ success: true, response });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
