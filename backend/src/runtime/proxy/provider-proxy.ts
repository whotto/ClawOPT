/**
 * 本地模型代理（spec 04 §2.6）。
 *
 * ## 两条路由族
 *
 * | 路由 | 客户端协议 | 典型调用方 |
 * |---|---|---|
 * | `/api/runtime-proxy/anthropic/:key/v1/{models,messages}` | Anthropic Messages | Claude Code |
 * | `/api/runtime-proxy/responses/:key/v1/{models,responses}` | OpenAI Responses | Codex、Pi、Grok、OpenCode、DSH |
 *
 * 上游可以是三种协议里任意一种：同协议直通（模型强制换成目标模型），异协议经中间表示翻译，
 * 流式响应边转边 tee 成规范事件（含用量）交给协调器。
 *
 * ## 凭据
 *
 * CLI 只拿到代理地址与**每目标令牌**；上游 key 只在本进程内存里，以及为重启恢复写的
 * **加密**目标文件里（AES-256-GCM，AAD 绑定目标的全部坐标与令牌，数据目录里 0600 的本机密钥）。
 * 令牌校验常数时间；未知 key 404、令牌不符 401，错误体按客户端协议的形状给。
 *
 * ## 出站
 *
 * 上游 base URL 只允许 http/https；解析到回环/内网只在服务商显式标成本地时放行（net-policy.ts）；
 * 不跟重定向。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Request, Response } from 'express';

import { canonicalJson } from '../../core/http';
import { assertOutboundUrlAllowed, isLocalProvider, NetPolicyError, type Lookup } from '../net-policy';
import { constantTimeEquals, LocalSecretBox, readPrivateText, writePrivateText } from '../platform-store';
import { isOfficialAnthropicUpstream, requiresReasoningContentRoundTrip, resolveUpstreamEndpoint } from './endpoints';
import { emitAnthropicRequest, isEncryptedThinkingError, parseAnthropicRequest, stripThinkingBlocks } from './request-anthropic';
import { emitChatRequest } from './request-chat';
import { toolNameMapOf, type ToolNameMap } from './request-ir';
import { applyGrokResponsesRewrite, applyResponsesRequestHygiene, emitResponsesRequest, parseResponsesRequest } from './request-responses';
import { isEventStreamContentType, parseJsonSafe, formatSseEvent, SseParser, type SseEvent } from './sse';
import {
  AnthropicStreamDecoder,
  ChatStreamDecoder,
  neutralFromAnthropicJson,
  neutralFromChatJson,
  neutralFromResponsesJson,
  ResponsesStreamDecoder,
  type StreamDecoder,
} from './stream-decoders';
import {
  AnthropicStreamEncoder,
  anthropicJsonFromNeutral,
  ResponsesStreamEncoder,
  responsesJsonFromNeutral,
  responsesUsageObject,
  type ResponsesUsagePolicy,
} from './stream-encoders';
import { NeutralAccumulator, type NeutralEvent } from './stream-neutral';
import { CanonicalTee } from './tee';
import { isApiMode, type ApiMode, type CanonicalRuntimeEvent, type ProviderProxy, type ProxyTarget, type RegisteredProxyTarget } from './types';

export const RUNTIME_PROXY_PREFIX = '/api/runtime-proxy';
export const ENCRYPTED_THINKING_PROBE_BYTES = 64 * 1024;
const UPSTREAM_HEADERS_TIMEOUT_MS = 5 * 60 * 1000;
const UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const LAST_USED_PERSIST_INTERVAL_MS = 10 * 60 * 1000;
/** 恢复时丢掉多久没用过的目标：CLI 每轮都会重新登记，过期的恢复文件只会堆积。 */
export const PROXY_TARGET_RESTORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLAUDE_MODEL_ALIASES = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'];

type ClientFamily = 'anthropic' | 'responses';

interface TargetEntry {
  routeKey: string;
  token: string;
  target: ProxyTarget;
  callSequence: number;
  lastUsedAt: number;
  lastPersistedAt: number;
}

export interface LocalProviderProxyOptions {
  /** 代理对 CLI 暴露的根地址（如 `http://127.0.0.1:3100`）。登记时取值，端口晚于构造确定也没关系。 */
  publicBaseUrl: () => string;
  /** 运行时数据目录（`<数据目录>/runtime`）；不给则不做重启恢复。 */
  dataDir?: string;
  fetchImpl?: typeof fetch;
  lookup?: Lookup;
  now?: () => number;
  log?: (message: string) => void;
}

class ProxyHttpError extends Error {
  constructor(readonly status: number, readonly errorType: string, message: string, readonly providerError?: unknown) {
    super(message);
  }
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function trimBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function readToken(req: Request): string {
  const apiKey = req.header('x-api-key');
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  const authorization = req.header('authorization') ?? '';
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
}

function sendClientError(res: Response, family: ClientFamily, status: number, errorType: string, message: string, providerError?: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (family === 'anthropic') {
    res.status(status).json({ type: 'error', error: { type: errorType, message }, ...(providerError !== undefined ? { provider_error: providerError } : {}) });
  } else {
    res.status(status).json({ error: { message, type: errorType, code: errorType }, ...(providerError !== undefined ? { provider_error: providerError } : {}) });
  }
}

/** 按上游格式挑流解码器。 */
function decoderFor(apiMode: ApiMode): StreamDecoder {
  if (apiMode === 'chat_completions') return new ChatStreamDecoder();
  if (apiMode === 'anthropic_messages') return new AnthropicStreamDecoder();
  return new ResponsesStreamDecoder();
}

function neutralFromJson(apiMode: ApiMode, json: unknown): NeutralEvent[] {
  if (apiMode === 'chat_completions') return neutralFromChatJson(json);
  if (apiMode === 'anthropic_messages') return neutralFromAnthropicJson(json);
  return neutralFromResponsesJson(json);
}

async function* readSseEvents(body: ReadableStream<Uint8Array>, mode: 'sse' | 'ndjson', signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const parser = new SseParser(mode);
  try {
    while (true) {
      let idleTimer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => reject(new ProxyHttpError(504, 'timeout_error', 'Upstream stream idle timeout')), UPSTREAM_IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      });
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await Promise.race([reader.read(), idle]);
      } finally {
        clearTimeout(idleTimer);
      }
      if (result.done) break;
      if (signal.aborted) return;
      for (const event of parser.push(result.value)) yield event;
    }
    for (const event of parser.end()) yield event;
  } finally {
    reader.releaseLock?.();
    try { await body.cancel(); } catch { /* 已经读完或已中止 */ }
  }
}

export class LocalProviderProxy implements ProviderProxy {
  private readonly entries = new Map<string, TargetEntry>();
  private readonly listeners = new Map<string, Set<(event: CanonicalRuntimeEvent) => void>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly secretBox: LocalSecretBox | null;
  private readonly targetsDir: string | null;

  constructor(private readonly options: LocalProviderProxyOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.log(message));
    this.secretBox = options.dataDir ? new LocalSecretBox(path.join(options.dataDir, 'proxy-target.key')) : null;
    this.targetsDir = options.dataDir ? path.join(options.dataDir, 'proxy-targets') : null;
  }

  // ---------------- 登记 / 订阅 ----------------

  private identityOf(target: ProxyTarget): string {
    return canonicalJson([target.runtime, target.provider, target.model, target.apiMode, trimBaseUrl(target.baseUrl), target.reasoningEffort ?? '', target.sessionId]);
  }

  register(target: ProxyTarget): RegisteredProxyTarget {
    if (!isApiMode(target.apiMode)) throw new ProxyHttpError(400, 'invalid_request_error', `Unsupported API mode: ${String(target.apiMode)}`);
    let parsed: URL;
    try {
      parsed = new URL(trimBaseUrl(target.baseUrl));
    } catch {
      throw new NetPolicyError('net.invalidUrl', 'Upstream base URL is not valid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new NetPolicyError('net.protocolNotAllowed', 'Upstream base URL must be http or https');
    }
    const normalized: ProxyTarget = { ...target, baseUrl: trimBaseUrl(target.baseUrl) };
    const routeKey = base64Url(crypto.createHash('sha256').update(`clawopt-runtime-proxy:${this.identityOf(normalized)}`).digest()).slice(0, 32);
    const existing = this.entries.get(routeKey);
    const entry: TargetEntry = existing
      ? { ...existing, target: normalized, lastUsedAt: this.now() }
      : { routeKey, token: `cwp_${base64Url(crypto.randomBytes(24))}`, target: normalized, callSequence: 0, lastUsedAt: this.now(), lastPersistedAt: 0 };
    this.entries.set(routeKey, entry);
    this.persist(entry);
    return this.describe(entry);
  }

  private describe(entry: TargetEntry): RegisteredProxyTarget {
    const base = this.options.publicBaseUrl().replace(/\/+$/, '');
    return {
      routeKey: entry.routeKey,
      token: entry.token,
      anthropicBaseUrl: `${base}${RUNTIME_PROXY_PREFIX}/anthropic/${entry.routeKey}`,
      responsesBaseUrl: `${base}${RUNTIME_PROXY_PREFIX}/responses/${entry.routeKey}/v1`,
      revoke: () => this.revoke(entry.routeKey, entry.token),
    };
  }

  private revoke(routeKey: string, token: string): void {
    const entry = this.entries.get(routeKey);
    // 同一坐标被重新登记后令牌不变；只有令牌对得上才删，旧句柄的 revoke 不误删新登记。
    if (!entry || entry.token !== token) return;
    this.entries.delete(routeKey);
    if (this.targetsDir) {
      try {
        fs.rmSync(path.join(this.targetsDir, `${routeKey}.json`), { force: true });
      } catch {
        this.log(`[RuntimeProxy] failed to remove restore file for ${routeKey.slice(0, 6)}…`);
      }
    }
  }

  onCanonicalEvent(runId: string, listener: (event: CanonicalRuntimeEvent) => void): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  private emitCanonical(runId: string, event: CanonicalRuntimeEvent): void {
    for (const listener of [...(this.listeners.get(runId) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        this.log(`[RuntimeProxy] canonical listener failed: ${(error as Error)?.name ?? 'Error'}`);
      }
    }
  }

  /** 诊断用：只报坐标，不报 key 与令牌。 */
  listTargets(): Array<Omit<ProxyTarget, 'apiKey'> & { routeKey: string; hasApiKey: boolean; lastUsedAt: number }> {
    return [...this.entries.values()].map(({ routeKey, target, lastUsedAt }) => {
      const { apiKey, ...rest } = target;
      return { ...rest, routeKey, hasApiKey: Boolean(apiKey), lastUsedAt };
    });
  }

  // ---------------- 重启恢复 ----------------

  private aadOf(routeKey: string, token: string, target: ProxyTarget): string {
    return canonicalJson(['clawopt-proxy-target/v1', routeKey, token, target.provider, target.model, target.baseUrl, target.apiMode, target.reasoningEffort ?? '', target.runtime, target.runId, target.sessionId]);
  }

  private persist(entry: TargetEntry): void {
    if (!this.secretBox || !this.targetsDir) return;
    const { apiKey, ...coordinates } = entry.target;
    const record = {
      v: 1,
      routeKey: entry.routeKey,
      token: entry.token,
      target: coordinates,
      apiKeyEncrypted: this.secretBox.seal(apiKey, this.aadOf(entry.routeKey, entry.token, entry.target)),
      lastUsedAt: entry.lastUsedAt,
    };
    try {
      writePrivateText(path.join(this.targetsDir, `${entry.routeKey}.json`), `${JSON.stringify(record)}\n`);
      entry.lastPersistedAt = this.now();
    } catch (error) {
      // 恢复文件写不下去不影响这一轮：只是重启后要等 CLI 下一次登记。
      this.log(`[RuntimeProxy] restore file not written: ${(error as NodeJS.ErrnoException)?.code ?? 'Error'}`);
    }
  }

  /** 启动时调用：把加密目标文件读回内存。返回恢复的个数；篡改、过期、坏文件跳过（过期的顺手删掉）。 */
  restore(): number {
    if (!this.secretBox || !this.targetsDir) return 0;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.targetsDir).filter((name) => name.endsWith('.json'));
    } catch {
      return 0;
    }
    let restored = 0;
    for (const name of names) {
      const filePath = path.join(this.targetsDir, name);
      const record = parseJsonSafe(readPrivateText(filePath) ?? '');
      const coordinates = record?.target;
      if (!record || record.v !== 1 || typeof record.routeKey !== 'string' || `${record.routeKey}.json` !== name || typeof record.token !== 'string' || !coordinates || !isApiMode(coordinates.apiMode)) {
        this.log(`[RuntimeProxy] skipped unreadable restore file ${name.slice(0, 6)}…`);
        continue;
      }
      if (typeof record.lastUsedAt === 'number' && this.now() - record.lastUsedAt > PROXY_TARGET_RESTORE_MAX_AGE_MS) {
        fs.rmSync(filePath, { force: true });
        continue;
      }
      const target: ProxyTarget = {
        provider: String(coordinates.provider ?? ''),
        model: String(coordinates.model ?? ''),
        baseUrl: String(coordinates.baseUrl ?? ''),
        apiKey: '',
        apiMode: coordinates.apiMode,
        reasoningEffort: typeof coordinates.reasoningEffort === 'string' ? coordinates.reasoningEffort : undefined,
        runtime: String(coordinates.runtime ?? ''),
        runId: String(coordinates.runId ?? ''),
        sessionId: String(coordinates.sessionId ?? ''),
      };
      const apiKey = this.secretBox.unseal(record.apiKeyEncrypted, this.aadOf(record.routeKey, record.token, target));
      if (apiKey === null) {
        this.log(`[RuntimeProxy] restore file failed authentication ${name.slice(0, 6)}…`);
        continue;
      }
      target.apiKey = apiKey;
      this.entries.set(record.routeKey, {
        routeKey: record.routeKey,
        token: record.token,
        target,
        callSequence: 0,
        lastUsedAt: typeof record.lastUsedAt === 'number' ? record.lastUsedAt : this.now(),
        lastPersistedAt: this.now(),
      });
      restored += 1;
    }
    return restored;
  }

  // ---------------- HTTP ----------------

  private authenticate(family: ClientFamily, req: Request, res: Response): TargetEntry | null {
    const entry = this.entries.get(String(req.params.key ?? ''));
    if (!entry) {
      sendClientError(res, family, 404, 'not_found_error', 'Unknown proxy route');
      return null;
    }
    const token = readToken(req);
    if (!token || !constantTimeEquals(token, entry.token)) {
      sendClientError(res, family, 401, 'authentication_error', 'Invalid proxy token');
      return null;
    }
    entry.lastUsedAt = this.now();
    if (this.now() - entry.lastPersistedAt > LAST_USED_PERSIST_INTERVAL_MS) this.persist(entry);
    return entry;
  }

  handleModels(family: ClientFamily, req: Request, res: Response): void {
    const entry = this.authenticate(family, req, res);
    if (!entry) return;
    const model = entry.target.model;
    if (family === 'anthropic') {
      const ids = [...new Set([...CLAUDE_MODEL_ALIASES, model])];
      res.json({
        data: ids.map((id) => ({ type: 'model', id, display_name: id === model ? `${model} (ClawOPT)` : id, created_at: '2025-01-01T00:00:00Z' })),
        has_more: false,
        first_id: ids[0],
        last_id: ids[ids.length - 1],
      });
      return;
    }
    res.json({ object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: entry.target.provider || 'clawopt' }] });
  }

  async handleMessages(req: Request, res: Response): Promise<void> {
    const entry = this.authenticate('anthropic', req, res);
    if (!entry) return;
    await this.runGuarded('anthropic', entry, req, res, () => this.proxyAnthropicClient(entry, req, res));
  }

  async handleResponses(req: Request, res: Response): Promise<void> {
    const entry = this.authenticate('responses', req, res);
    if (!entry) return;
    await this.runGuarded('responses', entry, req, res, () => this.proxyResponsesClient(entry, req, res));
  }

  private async runGuarded(family: ClientFamily, entry: TargetEntry, req: Request, res: Response, fn: () => Promise<void>): Promise<void> {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      sendClientError(res, family, 400, 'invalid_request_error', 'Request body must be a JSON object');
      return;
    }
    try {
      await fn();
    } catch (error) {
      if (error instanceof ProxyHttpError) {
        sendClientError(res, family, error.status, error.errorType, error.message, error.providerError);
      } else if (error instanceof NetPolicyError) {
        sendClientError(res, family, 403, 'permission_error', `Upstream address rejected (${error.errorCode})`);
      } else if ((error as Error)?.name === 'AbortError') {
        if (!res.writableEnded) res.end();
      } else {
        this.log(`[RuntimeProxy] ${entry.target.runtime} request failed: ${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? 'Error'}`);
        sendClientError(res, family, 502, 'api_error', 'Upstream request failed');
      }
    }
  }

  private async callUpstream(entry: TargetEntry, body: Record<string, unknown>, stream: boolean, signal: AbortSignal, forwardHeaders: Record<string, string> = {}): Promise<globalThis.Response> {
    const { target } = entry;
    const endpoint = resolveUpstreamEndpoint(target.baseUrl, target.apiMode);
    const url = await assertOutboundUrlAllowed(endpoint, { protocols: ['http:', 'https:'], allowPrivate: isLocalProvider(target.provider), lookup: this.options.lookup });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      ...forwardHeaders,
    };
    if (target.apiKey) headers.authorization = `Bearer ${target.apiKey}`;
    if (target.apiMode === 'anthropic_messages') {
      if (target.apiKey) headers['x-api-key'] = target.apiKey;
      headers['anthropic-version'] = forwardHeaders['anthropic-version'] ?? '2023-06-01';
    }
    if (/(^|\.)opencode\.ai$/i.test(url.hostname)) headers['x-opencode-session'] = target.sessionId || entry.routeKey;

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const headersTimer = setTimeout(abort, UPSTREAM_HEADERS_TIMEOUT_MS);
    headersTimer.unref?.();
    try {
      const response = await this.fetchImpl(url.toString(), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        throw new ProxyHttpError(502, 'api_error', 'Upstream redirect was not followed');
      }
      return response;
    } finally {
      clearTimeout(headersTimer);
    }
  }

  private async readUpstreamError(response: globalThis.Response): Promise<ProxyHttpError> {
    const text = await response.text().catch(() => '');
    const json = parseJsonSafe(text);
    const message = typeof json?.error?.message === 'string' ? json.error.message
      : typeof json?.message === 'string' ? json.message
        : `Provider returned HTTP ${response.status}`;
    const status = response.status >= 400 && response.status < 600 ? response.status : 502;
    return new ProxyHttpError(status, status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'api_error', message, json?.error ?? json ?? undefined);
  }

  private clientAbortSignal(req: Request, res: Response): AbortSignal {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    req.on('aborted', () => controller.abort());
    return controller.signal;
  }

  private startSse(res: Response): void {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }

  private newTee(entry: TargetEntry): CanonicalTee {
    entry.callSequence += 1;
    const runId = entry.target.runId;
    return new CanonicalTee(entry.target, entry.callSequence, (event) => this.emitCanonical(runId, event));
  }

  // ---- Anthropic 客户端 ----

  private async proxyAnthropicClient(entry: TargetEntry, req: Request, res: Response): Promise<void> {
    const { target } = entry;
    const body = req.body as Record<string, any>;
    const clientModel = typeof body.model === 'string' && body.model ? body.model : target.model;
    const stream = body.stream === true;
    const signal = this.clientAbortSignal(req, res);

    if (target.apiMode === 'anthropic_messages') {
      const forward: Record<string, string> = {};
      for (const name of ['anthropic-version', 'anthropic-beta']) {
        const value = req.header(name);
        if (typeof value === 'string' && value) forward[name] = value;
      }
      const upstreamBody = { ...body, model: target.model };
      const retryAllowed = !isOfficialAnthropicUpstream(target.baseUrl);
      await this.anthropicPassthrough(entry, upstreamBody, stream, forward, retryAllowed, signal, res);
      return;
    }

    const ir = parseAnthropicRequest(body);
    const upstreamBody = target.apiMode === 'chat_completions'
      ? emitChatRequest(ir, {
        model: target.model,
        stream,
        reasoningEffort: target.reasoningEffort,
        preserveReasoningContent: requiresReasoningContentRoundTrip(target),
        systemAsDeveloper: target.runtime === 'grok',
      })
      : emitResponsesRequest(ir, { model: target.model, stream, reasoningEffort: target.reasoningEffort });
    const upstream = await this.callUpstream(entry, upstreamBody, stream, signal);
    if (!upstream.ok) throw await this.readUpstreamError(upstream);
    const tee = this.newTee(entry);

    if (!stream) {
      const json = parseJsonSafe(await upstream.text());
      if (!json) throw new ProxyHttpError(502, 'api_error', 'Provider returned an empty or invalid body');
      const accumulator = new NeutralAccumulator({ id: `msg_${entry.callSequence}`, model: clientModel });
      for (const event of neutralFromJson(target.apiMode, json)) {
        accumulator.push(event);
        tee.push(event);
      }
      if (accumulator.response.error) throw new ProxyHttpError(502, 'api_error', accumulator.response.error.message);
      res.json(anthropicJsonFromNeutral(accumulator.response, clientModel));
      return;
    }

    const mode = isEventStreamContentType(upstream.headers.get('content-type'));
    if (!mode || !upstream.body) throw await this.readUpstreamError(upstream);
    const decoder = decoderFor(target.apiMode);
    const encoder = new AnthropicStreamEncoder(clientModel);
    this.startSse(res);
    for await (const sse of readSseEvents(upstream.body, mode, signal)) {
      for (const event of decoder.push(sse)) {
        tee.push(event);
        const text = encoder.push(event);
        if (text) res.write(text);
      }
      if (decoder.finished) break;
    }
    for (const event of decoder.end()) {
      tee.push(event);
      const text = encoder.push(event);
      if (text) res.write(text);
    }
    const tail = encoder.finalize();
    if (tail) res.write(tail);
    res.end();
  }

  private async anthropicPassthrough(
    entry: TargetEntry,
    upstreamBody: Record<string, unknown>,
    stream: boolean,
    forward: Record<string, string>,
    retryAllowed: boolean,
    signal: AbortSignal,
    res: Response,
  ): Promise<void> {
    const { target } = entry;
    let upstream = await this.callUpstream(entry, upstreamBody, stream, signal, forward);
    let retried = false;
    const retry = async () => {
      retried = true;
      this.log(`[RuntimeProxy] ${target.runtime}: upstream rejected encrypted thinking; retrying once without historical thinking blocks`);
      upstream = await this.callUpstream(entry, stripThinkingBlocks(upstreamBody), stream, signal, forward);
    };

    if (!upstream.ok) {
      const error = await this.readUpstreamError(upstream);
      if (!(retryAllowed && upstream.status === 400 && isEncryptedThinkingError(error.providerError))) throw error;
      await retry();
      if (!upstream.ok) throw await this.readUpstreamError(upstream);
    }

    const tee = this.newTee(entry);
    if (!stream) {
      const text = await upstream.text();
      const json = parseJsonSafe(text);
      if (!json) throw new ProxyHttpError(502, 'api_error', 'Provider returned an empty or invalid body');
      for (const event of neutralFromAnthropicJson(json)) tee.push(event);
      res.status(200).type('application/json').send(text);
      return;
    }

    let mode = isEventStreamContentType(upstream.headers.get('content-type'));
    if (!mode || !upstream.body) throw await this.readUpstreamError(upstream);
    let events = readSseEvents(upstream.body, mode, signal);
    let buffered: SseEvent[] = [];

    // 200 的 SSE 里也可能在任何业务帧之前先来一个「加密思维块解不开」的 error 帧：
    // 在前 64 KiB 内（忽略 ping）看到它就重试一次；一旦看到业务帧就不再重试（绝不在部分交付之后重放）。
    if (retryAllowed && !retried) {
      let bytes = 0;
      let retryNow = false;
      while (true) {
        const next = await events.next();
        if (next.done) break;
        buffered.push(next.value);
        bytes += next.value.data.length;
        const payload = parseJsonSafe(next.value.data);
        const type = payload?.type ?? next.value.event;
        if (type === 'ping') {
          if (bytes > ENCRYPTED_THINKING_PROBE_BYTES) break;
          continue;
        }
        if (type === 'error' && isEncryptedThinkingError(payload)) retryNow = true;
        break;
      }
      if (retryNow) {
        await events.return(undefined);
        await retry();
        if (!upstream.ok) throw await this.readUpstreamError(upstream);
        mode = isEventStreamContentType(upstream.headers.get('content-type'));
        if (!mode || !upstream.body) throw await this.readUpstreamError(upstream);
        events = readSseEvents(upstream.body, mode, signal);
        buffered = [];
      }
    }

    const decoder = new AnthropicStreamDecoder();
    this.startSse(res);
    const forwardEvent = (sse: SseEvent) => {
      for (const event of decoder.push(sse)) tee.push(event);
      res.write(formatSseEvent(sse.event, sse.data));
    };
    for (const sse of buffered) forwardEvent(sse);
    for await (const sse of events) forwardEvent(sse);
    for (const event of decoder.end()) tee.push(event);
    res.end();
  }

  // ---- Responses 客户端 ----

  private async proxyResponsesClient(entry: TargetEntry, req: Request, res: Response): Promise<void> {
    const { target } = entry;
    let body = applyResponsesRequestHygiene(req.body as Record<string, any>);
    if (target.runtime === 'grok') body = applyGrokResponsesRewrite(body);
    const clientModel = typeof body.model === 'string' && body.model ? body.model : target.model;
    const stream = body.stream === true;
    const signal = this.clientAbortSignal(req, res);
    const zeroFillUsage = target.runtime === 'opencode';

    if (target.apiMode === 'responses') {
      const upstream = await this.callUpstream(entry, { ...body, model: target.model }, stream, signal);
      if (!upstream.ok) throw await this.readUpstreamError(upstream);
      const tee = this.newTee(entry);
      if (!stream) {
        const json = parseJsonSafe(await upstream.text());
        if (!json) throw new ProxyHttpError(502, 'api_error', 'Provider returned an empty or invalid body');
        for (const event of neutralFromResponsesJson(json)) tee.push(event);
        if (zeroFillUsage && !json.usage) json.usage = responsesUsageObject(null);
        res.json(json);
        return;
      }
      const mode = isEventStreamContentType(upstream.headers.get('content-type'));
      if (!mode || !upstream.body) throw await this.readUpstreamError(upstream);
      const decoder = new ResponsesStreamDecoder();
      this.startSse(res);
      for await (const sse of readSseEvents(upstream.body, mode, signal)) {
        for (const event of decoder.push(sse)) tee.push(event);
        let data = sse.data;
        if (zeroFillUsage) {
          const payload = parseJsonSafe(data);
          if (payload?.type === 'response.completed' && payload.response && !payload.response.usage) {
            // OpenCode 收不到用量就把结束原因当未知、无限重试：补一个全零的。
            payload.response.usage = responsesUsageObject(null);
            data = JSON.stringify(payload);
          }
        }
        res.write(formatSseEvent(sse.event, data));
      }
      for (const event of decoder.end()) tee.push(event);
      res.end();
      return;
    }

    const ir = parseResponsesRequest(body);
    const toolNames: ToolNameMap = toolNameMapOf(ir);
    const upstreamBody = target.apiMode === 'chat_completions'
      ? emitChatRequest(ir, {
        model: target.model,
        stream,
        reasoningEffort: target.reasoningEffort,
        preserveReasoningContent: requiresReasoningContentRoundTrip(target),
        systemAsDeveloper: target.runtime === 'grok',
      })
      : emitAnthropicRequest(ir, { model: target.model, stream });
    const upstream = await this.callUpstream(entry, upstreamBody, stream, signal);
    if (!upstream.ok) throw await this.readUpstreamError(upstream);
    const tee = this.newTee(entry);
    // 非原生 Responses 上游：用量由 tee 单独记账，不塞进给 CLI 的终态帧（OpenCode 例外，必须有）。
    const usagePolicy: ResponsesUsagePolicy = zeroFillUsage ? 'zero_fill' : 'strip';

    if (!stream) {
      const json = parseJsonSafe(await upstream.text());
      if (!json) throw new ProxyHttpError(502, 'api_error', 'Provider returned an empty or invalid body');
      const accumulator = new NeutralAccumulator({ id: `resp_${entry.callSequence}`, model: clientModel });
      for (const event of neutralFromJson(target.apiMode, json)) {
        accumulator.push(event);
        tee.push(event);
      }
      res.json(responsesJsonFromNeutral(accumulator.response, { model: clientModel, toolNames, usagePolicy }));
      return;
    }

    const mode = isEventStreamContentType(upstream.headers.get('content-type'));
    if (!mode || !upstream.body) throw await this.readUpstreamError(upstream);
    const decoder = decoderFor(target.apiMode);
    const encoder = new ResponsesStreamEncoder({ model: clientModel, toolNames, usagePolicy });
    this.startSse(res);
    for await (const sse of readSseEvents(upstream.body, mode, signal)) {
      for (const event of decoder.push(sse)) {
        tee.push(event);
        const text = encoder.push(event);
        if (text) res.write(text);
      }
      if (decoder.finished) break;
    }
    for (const event of decoder.end()) {
      tee.push(event);
      const text = encoder.push(event);
      if (text) res.write(text);
    }
    const tail = encoder.finalize();
    if (tail) res.write(tail);
    res.end();
  }
}

export function createProviderProxy(options: LocalProviderProxyOptions): LocalProviderProxy {
  return new LocalProviderProxy(options);
}
