/**
 * NDJSON 上的 JSON-RPC 2.0（Codex app-server、ACP）。
 *
 * 只管关联：请求 id → promise、超时、通知分发、服务端发来的请求交给处理器并回写结果。
 * 行从执行器的 `onStdoutLine` 喂进来（严格 LF 切行已在执行器里做了），写经 `write`。
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcRequestError extends Error {
  constructor(readonly method: string, readonly rpcError: JsonRpcError | { code: 'timeout' | 'closed'; message: string }) {
    super(`${method}: ${rpcError.message}`);
  }
}

export interface JsonRpcPeerOptions {
  write(line: string): void;
  onNotification?(method: string, params: any): void;
  /** 服务端 → 客户端请求。返回结果；抛 `JsonRpcRequestError` 或返回 undefined 回 -32601。 */
  onRequest?(method: string, params: any): Promise<unknown> | unknown;
  defaultTimeoutMs?: number;
  /** 客户端请求 id 的前缀（Codex 的压缩流程用 0/1/2 这种纯数字 id，所以允许数字）。 */
  numericIds?: boolean;
}

interface Pending {
  method: string;
  resolve(value: any): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export class JsonRpcPeer {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly options: JsonRpcPeerOptions) {}

  request<T = any>(method: string, params?: unknown, timeoutMs = this.options.defaultTimeoutMs ?? 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new JsonRpcRequestError(method, { code: 'closed', message: 'connection closed' }));
    const id = this.options.numericIds ? this.seq++ : `clawopt_${this.seq++}`;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new JsonRpcRequestError(method, { code: 'timeout', message: `timed out after ${timeoutMs} ms` }));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(String(id), entry);
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private send(message: unknown): void {
    this.options.write(`${JSON.stringify(message)}\n`);
  }

  /** 喂一行。返回 false 表示这一行不是 JSON-RPC（调用方可以当普通输出处理）。 */
  handleLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return true;
    let message: any;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return false;
    }
    if (!message || typeof message !== 'object' || (message.jsonrpc !== '2.0' && !('id' in message) && !('method' in message))) return false;

    if ('method' in message && 'id' in message && message.id !== null) {
      void this.answerServerRequest(message.id, String(message.method), message.params);
      return true;
    }
    if ('method' in message) {
      try { this.options.onNotification?.(String(message.method), message.params); } catch { /* 订阅方抛错不影响连接 */ }
      return true;
    }
    if ('id' in message) {
      const entry = this.pending.get(String(message.id));
      if (!entry) return true;
      this.pending.delete(String(message.id));
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(new JsonRpcRequestError(entry.method, message.error));
      else entry.resolve(message.result);
      return true;
    }
    return false;
  }

  private async answerServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest?.(method, params);
      if (result === undefined) {
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
        return;
      }
      this.send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const rpc = error instanceof JsonRpcRequestError && typeof (error.rpcError as JsonRpcError).code === 'number'
        ? (error.rpcError as JsonRpcError)
        : { code: -32603, message: (error as Error)?.message || 'internal error' };
      this.send({ jsonrpc: '2.0', id, error: rpc });
    }
  }

  /** 连接关了：所有挂着的请求一起失败。 */
  close(reason = 'connection closed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new JsonRpcRequestError(entry.method, { code: 'closed', message: reason }));
      this.pending.delete(id);
    }
  }
}
