import express from 'express';

export type SplitChatProcessOutputResult = {
  finalContent: string;
  processContent: string;
  processStreaming: boolean;
};

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

export function isStreamingClientOpen(res: express.Response): boolean {
  return !res.writableEnded && !res.destroyed;
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

/**
 * 单聊里还不经运行协调器的本地操作（直连模型、生图）。
 * OpenClaw 网关运行已迁到协调器（runtime/adapters/openclaw.ts + openclaw-chat-projection.ts）；
 * 这两类本地操作的迁移留给 P1b，届时本管理器随之删除。
 */
export function createChatRuns() {
  return {
    localChatOperationManager: new LocalChatOperationManager(),
  };
}
export type ChatRuns = ReturnType<typeof createChatRuns>;
