/**
 * relay 帧通道：在一条 `ws` WebSocket 上做 req / res / evt（Socket.IO 那种 ack 语义的最小实现，不引依赖）。
 *
 * - `request(type, data, timeoutMs)`：发 req，等同 id 的 res；超时、连接断开都 reject（调用方据此判「结局未知」）；
 * - `onRequest(type, handler)`：处理对面的 req，handler 返回值作为 res 的 data，抛 `RelayProtocolError` 回 error；
 * - `emit(type, data)` / `onEvent(type, handler)`：单向事件；
 * - 帧解析失败 / 形状不对 → 立刻关闭连接（协议错误不容忍）。
 */
import type WebSocket from 'ws';

import { parseFrame, RelayProtocolError, type RelayFrame } from './protocol';

type Pending = { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class RelayChannelClosedError extends Error {
  constructor() {
    super('relay channel closed');
    this.name = 'RelayChannelClosedError';
  }
}

export class RelayRequestError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'RelayRequestError';
  }
}

export class RelayChannel {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  private readonly eventHandlers = new Map<string, (data: unknown) => void>();
  private readonly closeListeners = new Set<(code: number, reason: string) => void>();
  private closed = false;

  constructor(private readonly socket: WebSocket, private readonly log: (message: string) => void = () => {}) {
    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        this.close(1003, 'binary frames are not supported');
        return;
      }
      let frame: RelayFrame;
      try {
        frame = parseFrame(raw as Buffer);
      } catch (error) {
        this.log(`[Relay] invalid frame: ${(error as Error).message}`);
        this.close(1002, 'protocol error');
        return;
      }
      void this.dispatch(frame);
    });
    socket.on('close', (code, reason) => this.handleClose(code, reason.toString()));
    socket.on('error', () => this.handleClose(1006, 'socket error'));
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private send(frame: RelayFrame): void {
    if (this.closed) throw new RelayChannelClosedError();
    this.socket.send(JSON.stringify(frame));
  }

  private async dispatch(frame: RelayFrame): Promise<void> {
    if (frame.kind === 'res') {
      const pending = this.pending.get(frame.id!);
      if (!pending) return;
      this.pending.delete(frame.id!);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new RelayRequestError(frame.error.code, frame.error.message));
      else pending.resolve(frame.data);
      return;
    }
    if (frame.kind === 'evt') {
      try {
        this.eventHandlers.get(frame.type)?.(frame.data);
      } catch (error) {
        this.log(`[Relay] event handler ${frame.type} failed: ${(error as Error).message}`);
      }
      return;
    }
    const handler = this.requestHandlers.get(frame.type);
    if (!handler) {
      this.safeSend({ v: 1, kind: 'res', id: frame.id, type: frame.type, error: { code: 'relay.unknownRequest' } });
      return;
    }
    try {
      const data = await handler(frame.data);
      this.safeSend({ v: 1, kind: 'res', id: frame.id, type: frame.type, data });
    } catch (error) {
      const code = error instanceof RelayProtocolError || error instanceof RelayRequestError ? error.code : 'relay.requestFailed';
      this.safeSend({ v: 1, kind: 'res', id: frame.id, type: frame.type, error: { code, message: (error as Error).message?.slice(0, 500) } });
    }
  }

  private safeSend(frame: RelayFrame): void {
    try {
      this.send(frame);
    } catch {
      // 连接已经关了：对面拿不到回应，由它自己的超时处理。
    }
  }

  request<T = unknown>(type: string, data: unknown, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new RelayChannelClosedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayRequestError('relay.ackTimeout', `${type} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      try {
        this.send({ v: 1, kind: 'req', id, type, data });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  emit(type: string, data: unknown): void {
    this.send({ v: 1, kind: 'evt', type, data });
  }

  onRequest(type: string, handler: (data: unknown) => unknown | Promise<unknown>): void {
    this.requestHandlers.set(type, handler);
  }

  onEvent(type: string, handler: (data: unknown) => void): void {
    this.eventHandlers.set(type, handler);
  }

  onClose(listener: (code: number, reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RelayChannelClosedError());
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) {
      try {
        listener(code, reason);
      } catch {
        // 监听者之间故障隔离。
      }
    }
  }

  close(code = 1000, reason = ''): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // 已关闭。
    }
    this.handleClose(code, reason);
  }
}
