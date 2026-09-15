/**
 * 假网关：实现单聊运行链路用到的那一截 OpenClawClient 接口。
 *
 * 本机 OpenClaw 没配模型服务商，真网关聊不起来；这里按 `openclaw-client.ts` 的事件形状
 * （chat.delta / chat.final / chat.aborted / chat.error / session.tool / disconnected）
 * 与请求形状（chat.send / chat.history / agent.wait / chat.abort）逐项替身，
 * 让「发消息 → 流式 → 工具 → 终态 → 对账」整条链路在测试里真的跑一遍。
 *
 * 它模拟的是网关的**可观察行为**，不是实现：历史里只放 role/content/stopReason，
 * 与 `chat-history-reconciliation.ts` 读取的字段一致。
 */
import { EventEmitter } from 'events';

type HistoryMessage = { role: string; content: unknown; stopReason?: string; timestamp?: number; errorMessage?: string };

export class FakeGatewayClient extends EventEmitter {
  connected = true;
  history: HistoryMessage[] = [];
  sent: Array<{ sessionKey: string; message: string; agentId?: string; runId: string }> = [];
  aborts: Array<{ sessionKey: string; runId?: string }> = [];
  subscribeCount = 0;
  unsubscribeCount = 0;
  private runSeq = 0;
  private settled = new Map<string, () => void>();
  private settledPromises = new Map<string, Promise<void>>();
  /** 下一次 chat.send 之前等它（用来卡住「准备阶段」）。 */
  sendGate: Promise<void> | null = null;
  /** 通用 RPC（`client.call`）：记下调用，回 `rpcResponses[method]`（没有则抛 unknown method）。 */
  calls: Array<{ method: string; params: any }> = [];
  rpcResponses: Record<string, unknown> = {};

  async call(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (!(method in this.rpcResponses)) throw new Error(`unknown method: ${method}`);
    return this.rpcResponses[method];
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnectCount = 0;

  /** 真客户端断开后，下一次 getConnection 会新建一个再连上；假网关直接保持可用，只计数。 */
  disconnect(): void {
    this.disconnectCount += 1;
  }

  async subscribeSessionEvents(): Promise<void> {
    this.subscribeCount += 1;
  }

  async unsubscribeSessionEvents(): Promise<void> {
    this.unsubscribeCount += 1;
  }

  async getChatHistory(_sessionKey: string, limit = 20): Promise<{ messages: HistoryMessage[] }> {
    return { messages: this.history.slice(-limit) };
  }

  async sendChatMessageStreaming(params: { sessionKey: string; message: string; agentId?: string }): Promise<{ runId: string; sessionKey: string }> {
    if (this.sendGate) await this.sendGate;
    const runId = `gw-run-${++this.runSeq}`;
    const agentId = params.agentId || 'main';
    const sessionKey = params.sessionKey.startsWith('agent:') ? params.sessionKey : `agent:${agentId}:chat:${params.sessionKey}`;
    this.sent.push({ sessionKey, message: params.message, agentId: params.agentId, runId });
    this.history.push({ role: 'user', content: params.message, timestamp: Date.now() });
    let resolve!: () => void;
    this.settledPromises.set(runId, new Promise<void>((r) => { resolve = r; }));
    this.settled.set(runId, resolve);
    return { runId, sessionKey };
  }

  async waitForRun(runId: string, timeoutMs = 90000): Promise<void> {
    const pending = this.settledPromises.get(runId);
    if (!pending) return;
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('agent.wait timeout')), timeoutMs)),
    ]);
  }

  async abortChat(params: { sessionKey: string; runId?: string; timeoutMs?: number }): Promise<{ aborted: boolean; runIds?: string[] }> {
    this.aborts.push({ sessionKey: params.sessionKey, runId: params.runId });
    if (params.runId) this.settled.get(params.runId)?.();
    return { aborted: true, runIds: params.runId ? [params.runId] : [] };
  }

  // ---- 驱动网关事件 ----

  lastRun(): { sessionKey: string; runId: string } {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error('no run was sent to the fake gateway');
    return last;
  }

  delta(text: string, run = this.lastRun()): void {
    this.emit('chat.delta', { sessionKey: run.sessionKey, runId: run.runId, text });
  }

  tool(phase: 'start' | 'update' | 'result', name: string, options: { id?: string; args?: Record<string, unknown>; isError?: boolean } = {}, run = this.lastRun()): void {
    this.emit('session.tool', {
      sessionKey: run.sessionKey,
      runId: run.runId,
      data: { phase, name, toolCallId: options.id, args: options.args, isError: options.isError },
    });
  }

  /** 终态：发 chat.final，并把最终助手消息写进历史、放行 agent.wait。 */
  final(text: string, run = this.lastRun(), extra: Record<string, unknown> = {}): void {
    const message = { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(), ...extra };
    this.history.push(message);
    this.emit('chat.final', { sessionKey: run.sessionKey, runId: run.runId, text, message });
    this.settled.get(run.runId)?.();
  }

  failRun(error: string, run = this.lastRun()): void {
    this.history.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: error, timestamp: Date.now() });
    this.emit('chat.error', { sessionKey: run.sessionKey, runId: run.runId, error });
    this.settled.get(run.runId)?.();
  }
}
