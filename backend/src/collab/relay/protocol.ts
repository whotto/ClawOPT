/**
 * 远程 Agent relay 协议（v1，ClawOPT 自有；spec 02 F19 / F20 的净室重写）。
 *
 * 角色：**host** = 拥有群的 ClawOPT；**target** = 把自己本机的 Agent（运行时）接进 host 群里的另一台 ClawOPT。
 * target 主动连 host（出站 WebSocket），host 经这条连接派发运行，target 回传事件——
 * 「Mac 执行、生产机协作」就是 Mac 当 target、生产机当 host。
 *
 * ## 帧
 *
 * 一条 WebSocket 上跑 JSON 帧：`{ v: 1, kind: 'req' | 'res' | 'evt', id?, type, data?, error? }`。
 * `req` 必须收到同 id 的 `res`（带超时）；`evt` 不需要回应。单帧 ≤ 8 MB，解析失败或形状不对直接断开。
 *
 * ## 握手
 *
 * 升级请求头：`x-clawopt-relay-protocol: 1`、`x-clawopt-relay-origin`（target 自报的来源，必须与配对时一致）、
 * `x-clawopt-relay-capabilities`；首次配对带 `x-clawopt-relay-request` + `x-clawopt-relay-ticket`（批准后 2 分钟内有效、一次性），
 * 重连带 `x-clawopt-relay-connector` + `authorization: Bearer <凭据>`（host 只存 SHA-256）。协议版本必须**完全相等**。
 * host 接受后发 `evt relay.ready`：协议版本、host 能力、connectorId、凭据（只在首次配对时给）、群 id / 名、描述符回显（target 必须逐字段核对）。
 *
 * ## 运行（host → target）
 *
 * `req run.request {runId, room, agentName, prompt, workspaceApi?}` → target 10 秒内回 `res {accepted: true}`；
 * target → host：`req agent.events {runId, events: [{seq, type, data}]}`（seq 从 1 严格连续；**同一时刻只有一帧在途**，收到 res 才发下一帧）；
 * 结束：`req run.completed {runId, outputText}` 或 `req run.failed {runId, error}`（错误已脱敏）。
 * host → target：`req approval.respond {runId, approvalId, choice}`、`req clarify.respond {runId, clarifyId, text}`、`req run.interrupt {runId, reason}`。
 *
 * **只有 target 明确发来的 `run.failed` 才是权威失败**；连接断开、事件序号错乱 / 越界、中止没有确认、超时，一律记 `relay.outcomeUnknown`
 * （喂给交接续跑状态机：不自动重跑可能已经执行过的远程工作）。
 */

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_WS_PATH = '/api/relay/v1/connect';
export const RELAY_CAPABILITY_BATCH = 'agent.events.v1';
export const RELAY_HOST_CAPABILITIES = [RELAY_CAPABILITY_BATCH] as const;

export const RELAY_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const RELAY_MAX_PROMPT_CHARS = 1_000_000;
export const RELAY_MAX_EVENTS_PER_FRAME = 64;
export const RELAY_MAX_EVENT_TEXT = 1_000_000;
export const RELAY_ACCEPT_TIMEOUT_MS = 10_000;
export const RELAY_ACK_TIMEOUT_MS = 30_000;
export const RELAY_SINK_MAX_PENDING_EVENTS = 2048;
export const RELAY_SINK_MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const RELAY_BATCH_DELAY_MS = 40;
export const RELAY_BATCH_MAX_BYTES = 16 * 1024;

export const RELAY_HEADERS = {
  protocol: 'x-clawopt-relay-protocol',
  origin: 'x-clawopt-relay-origin',
  capabilities: 'x-clawopt-relay-capabilities',
  request: 'x-clawopt-relay-request',
  ticket: 'x-clawopt-relay-ticket',
  connector: 'x-clawopt-relay-connector',
  secret: 'x-clawopt-relay-secret',
} as const;

export type RelayFrame = {
  v: 1;
  kind: 'req' | 'res' | 'evt';
  id?: number;
  type: string;
  data?: unknown;
  error?: { code: string; message?: string };
};

export type RelayDescriptor = {
  runtime: string;
  name: string;
  description: string;
  mode: 'global' | 'scoped';
  model: string;
};

export type RelayEventType = 'text.delta' | 'reasoning.delta' | 'tool.started' | 'tool.completed' | 'approval.requested' | 'clarify.requested' | 'interaction.resolved';

export const RELAY_EVENT_TYPES: ReadonlySet<string> = new Set<RelayEventType>(['text.delta', 'reasoning.delta', 'tool.started', 'tool.completed', 'approval.requested', 'clarify.requested', 'interaction.resolved']);
export const RELAY_HIGH_FREQUENCY_EVENTS: ReadonlySet<string> = new Set(['text.delta', 'reasoning.delta']);

export type RelayEvent = { seq: number; type: RelayEventType; data: Record<string, unknown> };

export class RelayProtocolError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'RelayProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number, field: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') throw new RelayProtocolError('relay.eventInvalid', `${field} must be a string`);
  if (!options.allowEmpty && value.length === 0) throw new RelayProtocolError('relay.eventInvalid', `${field} is empty`);
  if (value.length > max) throw new RelayProtocolError('relay.eventInvalid', `${field} is too long`);
  return value;
}

export function parseFrame(raw: string | Buffer): RelayFrame {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (Buffer.byteLength(text) > RELAY_MAX_FRAME_BYTES) throw new RelayProtocolError('relay.frameTooLarge');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RelayProtocolError('relay.frameInvalid', 'frame is not JSON');
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !['req', 'res', 'evt'].includes(String(parsed.kind)) || typeof parsed.type !== 'string' || parsed.type.length > 64) {
    throw new RelayProtocolError('relay.frameInvalid', 'frame shape is invalid');
  }
  if (parsed.kind !== 'evt' && (!Number.isInteger(parsed.id) || (parsed.id as number) <= 0)) throw new RelayProtocolError('relay.frameInvalid', 'frame id is invalid');
  return parsed as RelayFrame;
}

const RUNTIME_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** 描述符：两边都按同一份判据校验（host 批准时、target 核对回显时）。 */
export function parseDescriptor(value: unknown): RelayDescriptor {
  if (!isRecord(value)) throw new RelayProtocolError('relay.descriptorInvalid');
  const runtime = boundedString(value.runtime, 40, 'runtime');
  if (!RUNTIME_ID.test(runtime) || runtime === 'relay') throw new RelayProtocolError('relay.descriptorInvalid', 'runtime id is invalid');
  const name = boundedString(value.name, 120, 'name').trim();
  if (!name || name.toLowerCase() === 'all' || /[@\n\r]/.test(name)) throw new RelayProtocolError('relay.descriptorInvalid', 'name is invalid');
  const description = boundedString(value.description ?? '', 2000, 'description', { allowEmpty: true });
  const mode = value.mode === 'scoped' ? 'scoped' : value.mode === 'global' || value.mode === undefined ? 'global' : null;
  if (!mode) throw new RelayProtocolError('relay.descriptorInvalid', 'mode is invalid');
  const model = boundedString(value.model ?? '', 500, 'model', { allowEmpty: true });
  return { runtime, name, description, mode, model };
}

export function descriptorsEqual(a: RelayDescriptor, b: RelayDescriptor): boolean {
  return a.runtime === b.runtime && a.name === b.name && a.description === b.description && a.mode === b.mode && a.model === b.model;
}

/** host 收到的一帧事件：runId 对得上、seq 严格连续、每种事件的字段有界。返回规范化的事件。 */
export function validateEventBatch(data: unknown, expected: { runId: string; nextSeq: number }): RelayEvent[] {
  if (!isRecord(data) || data.runId !== expected.runId) throw new RelayProtocolError('relay.staleRun');
  if (!Array.isArray(data.events) || data.events.length === 0 || data.events.length > RELAY_MAX_EVENTS_PER_FRAME) throw new RelayProtocolError('relay.eventInvalid', 'events must be a non-empty bounded array');
  let seq = expected.nextSeq;
  return data.events.map((raw) => {
    if (!isRecord(raw)) throw new RelayProtocolError('relay.eventInvalid');
    if (raw.seq !== seq) throw new RelayProtocolError('relay.eventSequence', `expected seq ${seq}`);
    seq += 1;
    const type = String(raw.type);
    if (!RELAY_EVENT_TYPES.has(type)) throw new RelayProtocolError('relay.eventUnsupported', type.slice(0, 64));
    const payload = isRecord(raw.data) ? raw.data : {};
    const out: Record<string, unknown> = {};
    switch (type as RelayEventType) {
      case 'text.delta':
      case 'reasoning.delta':
        out.text = boundedString(payload.text, RELAY_MAX_EVENT_TEXT, 'text');
        break;
      case 'tool.started':
        out.callId = boundedString(payload.callId, 200, 'callId');
        out.name = boundedString(payload.name, 200, 'name');
        out.arguments = boundedString(payload.arguments ?? '', 200_000, 'arguments', { allowEmpty: true });
        break;
      case 'tool.completed':
        out.callId = boundedString(payload.callId, 200, 'callId');
        out.output = boundedString(payload.output ?? '', 200_000, 'output', { allowEmpty: true });
        out.status = payload.status === 'failed' ? 'failed' : 'completed';
        break;
      case 'approval.requested': {
        out.approvalId = boundedString(payload.approvalId, 200, 'approvalId');
        out.title = boundedString(payload.title ?? '', 2000, 'title', { allowEmpty: true });
        out.description = boundedString(payload.description ?? '', 20_000, 'description', { allowEmpty: true });
        out.command = boundedString(payload.command ?? '', 20_000, 'command', { allowEmpty: true });
        const choices = Array.isArray(payload.choices) ? payload.choices.filter((choice) => ['once', 'session', 'always', 'deny'].includes(String(choice))) : [];
        out.choices = choices.length > 0 ? [...new Set(choices)] : ['once', 'deny'];
        out.timeoutMs = Math.min(600_000, Math.max(1000, Number(payload.timeoutMs) || 300_000));
        break;
      }
      case 'clarify.requested':
        out.clarifyId = boundedString(payload.clarifyId, 200, 'clarifyId');
        out.question = boundedString(payload.question ?? '', 20_000, 'question', { allowEmpty: true });
        out.choices = Array.isArray(payload.choices) ? payload.choices.slice(0, 64).map((choice) => String(choice).slice(0, 500)) : null;
        out.timeoutMs = Math.min(600_000, Math.max(1000, Number(payload.timeoutMs) || 300_000));
        break;
      case 'interaction.resolved':
        out.id = boundedString(payload.id, 200, 'id');
        break;
    }
    return { seq: raw.seq as number, type: type as RelayEventType, data: out };
  });
}

/** 递归把秘密字符串换成占位符（target 发往 host 的一切事件与错误都过它）。 */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const active = secrets.filter((secret) => secret.length >= 8);
  if (active.length === 0) return value;
  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') return active.reduce((text, secret) => text.split(secret).join('[redacted]'), input);
    if (Array.isArray(input)) return input.map(scrub);
    if (isRecord(input)) return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, scrub(item)]));
    return input;
  };
  return scrub(value) as T;
}

/** 配对码：target 页面粘贴的一段 base64url JSON（host 地址 + 请求 id + 请求密钥 + 一次性票据）。 */
export type PairingCode = { v: 1; hostUrl: string; requestId: string; secret: string; ticket: string; roomName: string };

export function encodePairingCode(code: Omit<PairingCode, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...code }), 'utf8').toString('base64url');
}

export function decodePairingCode(raw: string): PairingCode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
  } catch {
    throw new RelayProtocolError('relay.pairingCodeInvalid');
  }
  if (!isRecord(parsed) || parsed.v !== 1) throw new RelayProtocolError('relay.pairingCodeInvalid');
  const hostUrl = boundedString(parsed.hostUrl, 2048, 'hostUrl');
  const requestId = boundedString(parsed.requestId, 64, 'requestId');
  const secret = boundedString(parsed.secret, 128, 'secret');
  const ticket = boundedString(parsed.ticket, 128, 'ticket');
  const roomName = boundedString(parsed.roomName ?? '', 200, 'roomName', { allowEmpty: true });
  if (!/^https?:\/\//.test(hostUrl)) throw new RelayProtocolError('relay.pairingCodeInvalid', 'host url must be http(s)');
  return { v: 1, hostUrl: hostUrl.replace(/\/+$/, ''), requestId, secret, ticket, roomName };
}
