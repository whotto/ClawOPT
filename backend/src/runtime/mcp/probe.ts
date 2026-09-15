/**
 * MCP 健康探测：连接 → `initialize` → `notifications/initialized` → `tools/list`。
 *
 * 不引 MCP SDK（共享 node_modules，见 toml-lite.ts 的理由），只实现探测需要的最小客户端：
 * - stdio：换行分隔的 JSON-RPC；子进程用白名单环境（调用方给）、独立进程组，结束或超时整组杀掉；
 * - http：Streamable HTTP，响应可以是 JSON 也可以是 SSE，带回 `mcp-session-id`。
 * 老式 SSE 传输（GET 建流 + POST 端点）不支持，探测报「不支持的传输」而不是挂住。
 */
import { spawn } from 'child_process';

import { sanitizeProcessOutput } from '../manager/process-runner';
import { SseParser } from '../proxy/sse';
import type { ManagedMcpServer, McpProbeResult } from './types';

export const MCP_PROBE_TIMEOUT_MS = 5000;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'clawopt-mcp-probe', version: '1' };

function toolsFrom(result: any): McpProbeResult['tools'] {
  return (Array.isArray(result?.tools) ? result.tools : []).map((tool: any) => ({
    name: String(tool?.name ?? ''),
    description: typeof tool?.description === 'string' ? tool.description : undefined,
    input_schema: tool?.inputSchema ?? tool?.input_schema,
  }));
}

function failure(message: string): McpProbeResult {
  return { ok: false, tools: [], error: sanitizeProcessOutput(message, { maxLines: 6 }) || 'probe failed' };
}

export function probeStdioServer(server: ManagedMcpServer, env: NodeJS.ProcessEnv, timeoutMs = MCP_PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    let buffer = '';
    const child = (() => {
      try {
        return spawn(server.command ?? '', server.args ?? [], { env: { ...env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32' });
      } catch (error) {
        resolve(failure((error as Error).message));
        return null;
      }
    })();
    if (!child) return;
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    };
    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish(failure(`MCP server did not answer within ${timeoutMs} ms${stderr ? `: ${stderr.slice(-400)}` : ''}`)), timeoutMs);
    timer.unref?.();
    const send = (message: unknown) => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        // 进程已退出：close 事件会收尾
      }
    };
    child.stdin?.on('error', () => {});
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => finish(failure(error.message)));
    child.on('close', (code) => finish(failure(`MCP server exited with code ${code}${stderr ? `: ${stderr.slice(-400)}` : ''}`)));
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // 有的服务往 stdout 打日志：跳过
        }
        if (message.id === 1) {
          if (message.error) return finish(failure(message.error.message ?? 'initialize failed'));
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          if (message.error) return finish(failure(message.error.message ?? 'tools/list failed'));
          return finish({ ok: true, tools: toolsFrom(message.result), error: null });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
  });
}

async function postJsonRpc(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<{ response: Response; message: any }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
    redirect: 'manual',
    signal,
  });
  if (!response.ok && response.status !== 202) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 202 || !contentType) return { response, message: null };
  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    const events = new SseParser().push(text);
    const target = (body as { id?: number }).id;
    for (const event of events) {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed?.id === target) return { response, message: parsed };
      } catch {
        // 跳过非 JSON 帧
      }
    }
    return { response, message: null };
  }
  return { response, message: JSON.parse(text) };
}

export async function probeHttpServer(server: ManagedMcpServer, timeoutMs = MCP_PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
  if (!server.url || !/^https?:\/\//i.test(server.url)) return failure('MCP url must be http(s)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const headers = { ...(server.headers ?? {}) };
    const init = await postJsonRpc(server.url, headers, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, controller.signal);
    if (init.message?.error) return failure(init.message.error.message ?? 'initialize failed');
    if (!init.message?.result) return failure('MCP server did not return an initialize result (unsupported transport?)');
    const sessionId = init.response.headers.get('mcp-session-id');
    if (sessionId) headers['mcp-session-id'] = sessionId;
    headers['mcp-protocol-version'] = String(init.message.result.protocolVersion ?? PROTOCOL_VERSION);
    await postJsonRpc(server.url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, controller.signal).catch(() => null);
    const list = await postJsonRpc(server.url, headers, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, controller.signal);
    if (list.message?.error) return failure(list.message.error.message ?? 'tools/list failed');
    return { ok: true, tools: toolsFrom(list.message?.result), error: null };
  } catch (error) {
    return failure(controller.signal.aborted ? `MCP server did not answer within ${timeoutMs} ms` : (error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export function probeMcpServer(server: ManagedMcpServer, env: NodeJS.ProcessEnv, timeoutMs = MCP_PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
  return server.transport === 'http' ? probeHttpServer(server, timeoutMs) : probeStdioServer(server, env, timeoutMs);
}
