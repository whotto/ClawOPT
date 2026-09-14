import express from 'express';

import { normalizeCliText } from '../../core/util';
import { extractOpenClawMessageText, OpenClawClient } from '../../openclaw';
import type { GroupToolProgressState } from '../rooms';
import {
  type ChatHistorySnapshot,
  isNonTerminalAssistantMessage,
} from './chat-history-reconciliation';
import { selectPreferredTextSnapshot } from './text-snapshot-protection';

export interface ActiveRun {
  sessionId: string;
  runId: string;
  agentId: string;
  agentName: string;
  modelUsed: string;
  messageId: number;
  startedAt: number;
  workspacePath: string;
  finalSessionKey: string;
  processStartTag?: string;
  processEndTag?: string;
  historySnapshot: ChatHistorySnapshot;
  rawText: string;
  text: string;
  modelProcessContent: string;
  modelProcessStreaming: boolean;
  toolProcessContent: string;
  processContent: string;
  processStreaming: boolean;
  clients: express.Response[]; // Active SSE clients listening to this run
  idleTimeout?: NodeJS.Timeout;
  completionProbeTimer?: NodeJS.Timeout;
  completionProbeInFlight?: boolean;
  completionProbePending?: boolean;
  firstCompletionWaitResolvedAt?: number;
  visibleFinalText?: string;
  visibleProcessContent?: string;
  visibleProcessStreaming?: boolean;
  finalEventText?: string;
  finalEventGeneration: number;
  settledCalibrationGeneration: number;
  latestFinalEventAt?: number;
  lastObservedHistoryLength: number;
  lastObservedHistorySignature: string;
  lastObservedHistoryActivityAt?: number;
  pendingErrorDetail?: string;
  toolProgressLines: string[];
  activeToolCallIds: Set<string>;
  toolProgressById: Map<string, GroupToolProgressState>;
  sessionEventsSubscribed?: boolean;
  clientRef?: OpenClawClient;
  cleanedUp?: boolean;
  gatewayReconnectTimer?: NodeJS.Timeout;
  gatewayReconnectInFlight?: boolean;
  gatewayDisconnectedAt?: number;
}

export type SplitChatProcessOutputResult = {
  finalContent: string;
  processContent: string;
  processStreaming: boolean;
};

interface PendingChatPreparation {
  sessionId: string;
  epoch: number;
  messageId: number;
  agentId: string;
  agentName: string;
  modelUsed: string;
  startedAt: number;
  clients: express.Response[];
}

type LocalChatOperationKind = 'image-generation' | 'direct-runtime' | 'local';

interface LocalChatOperation {
  sessionId: string;
  epoch: number;
  messageId: number;
  agentId: string;
  agentName: string;
  modelUsed: string;
  startedAt: number;
  kind: LocalChatOperationKind;
  abortController?: AbortController;
  clients: express.Response[];
  cleanedUp?: boolean;
}

export function resolveChatFinalTextSnapshot(text: string, message: any): string {
  if (isNonTerminalAssistantMessage(message)) {
    return '';
  }
  return selectPreferredTextSnapshot(text, extractOpenClawMessageText(message));
}

export function isStreamingClientOpen(res: express.Response): boolean {
  return !res.writableEnded && !res.destroyed;
}

export function isRecoverableGatewayDisconnectDetail(detail?: string | null): boolean {
  const normalized = normalizeCliText(detail);
  if (!normalized) return false;
  return /Client disconnected|connection is not open|ECONNREFUSED|ECONNRESET|EPIPE|gateway connect timeout|Gateway connect failed|WebSocket/i.test(normalized);
}

export class PendingChatPreparationManager {
  private pending = new Map<string, PendingChatPreparation>();

  private matchesEpoch(preparation: PendingChatPreparation | undefined, expectedEpoch?: number): preparation is PendingChatPreparation {
    if (!preparation) return false;
    return expectedEpoch === undefined || preparation.epoch === expectedEpoch;
  }

  get(sessionId: string, expectedEpoch?: number): PendingChatPreparation | undefined {
    const preparation = this.pending.get(sessionId);
    return this.matchesEpoch(preparation, expectedEpoch) ? preparation : undefined;
  }

  start(preparation: Omit<PendingChatPreparation, 'clients'>): PendingChatPreparation {
    const nextPreparation: PendingChatPreparation = {
      ...preparation,
      clients: [],
    };
    this.pending.set(preparation.sessionId, nextPreparation);
    return nextPreparation;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean; expectedEpoch?: number }): boolean {
    const preparation = this.get(sessionId, options?.expectedEpoch);
    if (!preparation || !isStreamingClientOpen(res)) return false;

    preparation.clients.push(res);
    res.on('close', () => {
      const current = this.get(sessionId, preparation.epoch);
      if (!current) return;
      current.clients = current.clients.filter((client) => client !== res);
    });
    if (options?.announceAttach) {
      res.write(`data: ${JSON.stringify({
        type: 'attached',
        messageId: preparation.messageId,
        agentId: preparation.agentId,
        agentName: preparation.agentName,
        modelUsed: preparation.modelUsed,
      })}\n\n`);
    }
    return true;
  }

  promoteClients(sessionId: string, expectedEpoch?: number): express.Response[] {
    const preparation = this.get(sessionId, expectedEpoch);
    if (!preparation) return [];
    this.pending.delete(sessionId);
    return preparation.clients.filter((client) => isStreamingClientOpen(client));
  }

  cancel(sessionId: string, expectedEpoch?: number) {
    const preparation = this.get(sessionId, expectedEpoch);
    if (!preparation) return;

    this.pending.delete(sessionId);
    preparation.clients
      .filter((client) => isStreamingClientOpen(client))
      .forEach((res) => {
        try {
          res.end();
        } catch {}
      });
  }

  fail(sessionId: string, payload: {
    content: string;
    messageCode?: string;
    messageParams?: Record<string, any>;
    rawDetail?: string | null;
    role: string;
  }, expectedEpoch?: number) {
    const preparation = this.get(sessionId, expectedEpoch);
    if (!preparation) return;

    this.pending.delete(sessionId);
    preparation.clients
      .filter((client) => isStreamingClientOpen(client))
      .forEach((res) => {
        try {
          res.write(`data: ${JSON.stringify({
            type: 'error',
            text: payload.content,
            messageCode: payload.messageCode,
            messageParams: payload.messageParams,
            rawDetail: payload.rawDetail,
            role: payload.role,
          })}\n\n`);
          res.end();
        } catch {}
      });
  }
}

export class LocalChatOperationManager {
  private operations = new Map<string, LocalChatOperation>();

  private matchesEpoch(operation: LocalChatOperation | undefined, expectedEpoch?: number): operation is LocalChatOperation {
    if (!operation) return false;
    return expectedEpoch === undefined || operation.epoch === expectedEpoch;
  }

  get(sessionId: string, expectedEpoch?: number): LocalChatOperation | undefined {
    const operation = this.operations.get(sessionId);
    return this.matchesEpoch(operation, expectedEpoch) ? operation : undefined;
  }

  start(operation: Omit<LocalChatOperation, 'clients'>): LocalChatOperation {
    const previous = this.operations.get(operation.sessionId);
    if (previous) {
      previous.abortController?.abort();
      this.cleanup(previous);
    }

    const nextOperation: LocalChatOperation = {
      ...operation,
      clients: [],
    };
    this.operations.set(operation.sessionId, nextOperation);
    return nextOperation;
  }

  attachClient(sessionId: string, res: express.Response, options?: { announceAttach?: boolean; expectedEpoch?: number }): boolean {
    const operation = this.get(sessionId, options?.expectedEpoch);
    if (!operation || !isStreamingClientOpen(res)) return false;

    operation.clients.push(res);
    res.on('close', () => {
      const current = this.get(sessionId, operation.epoch);
      if (!current) return;
      current.clients = current.clients.filter((client) => client !== res);
    });

    if (options?.announceAttach) {
      res.write(`data: ${JSON.stringify({
        type: 'attached',
        messageId: operation.messageId,
        agentId: operation.agentId,
        agentName: operation.agentName,
        modelUsed: operation.modelUsed,
      })}\n\n`);
    }

    return true;
  }

  emit(sessionId: string, event: Record<string, unknown>, expectedEpoch?: number): void {
    const operation = this.get(sessionId, expectedEpoch);
    if (!operation) return;

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    operation.clients = operation.clients.filter((res) => {
      if (!isStreamingClientOpen(res)) return false;
      try {
        res.write(payload);
        return isStreamingClientOpen(res);
      } catch {
        return false;
      }
    });
  }

  finish(sessionId: string, expectedEpoch?: number): void {
    const operation = this.get(sessionId, expectedEpoch);
    if (!operation) return;
    this.cleanup(operation);
  }

  abort(sessionId: string, expectedEpoch?: number): { aborted: boolean } {
    const operation = this.get(sessionId, expectedEpoch);
    if (!operation) return { aborted: false };

    operation.abortController?.abort();
    this.cleanup(operation);
    return { aborted: true };
  }

  private cleanup(operation: LocalChatOperation): void {
    if (operation.cleanedUp) {
      if (this.operations.get(operation.sessionId) === operation) {
        this.operations.delete(operation.sessionId);
      }
      return;
    }

    operation.cleanedUp = true;
    operation.clients
      .filter((client) => isStreamingClientOpen(client))
      .forEach((res) => {
        try {
          res.end();
        } catch {}
      });
    operation.clients = [];
    if (this.operations.get(operation.sessionId) === operation) {
      this.operations.delete(operation.sessionId);
    }
  }
}
