/**
 * 真组装的应用（真 DB、真路由、真运行协调器，可选真 WebSocket 通道），HOME 指向一次性临时目录，网关换成假网关。
 *
 * 模块在导入时就读 HOME / CLAWOPT_DATA_DIR 算路径，所以必须**先改环境变量再动态导入**。
 * 关闭时恢复环境变量并删掉临时目录。
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

export type AppHarness = {
  baseUrl: string;
  home: string;
  ctx: any;
  server: http.Server;
  close: () => Promise<void>;
};

export async function startAppHarness(options: { openclawConfig?: Record<string, unknown>; attachRealtime?: boolean } = {}): Promise<AppHarness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-harness-'));
  const previous = { HOME: process.env.HOME, CLAWOPT_DATA_DIR: process.env.CLAWOPT_DATA_DIR };
  process.env.HOME = home;
  process.env.CLAWOPT_DATA_DIR = '.clawopt-test';
  fs.mkdirSync(path.join(home, '.openclaw', 'workspace-main'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify(options.openclawConfig ?? {
    agents: {
      defaults: { model: { primary: 'fake/model-1' } },
      list: [{ id: 'main', workspace: path.join(home, '.openclaw', 'workspace-main') }],
    },
  }, null, 2));

  const { createAppContext } = await import('../../src/bootstrap/context');
  const { buildApp } = await import('../../src/bootstrap/app');
  const ctx = createAppContext();
  const { app } = buildApp(ctx);
  const server = http.createServer(app);
  let realtimeServer: { close: () => Promise<void> } | null = null;
  if (options.attachRealtime) {
    const { attachRealtimeServer } = await import('../../src/bootstrap/realtime');
    realtimeServer = attachRealtimeServer(server, ctx);
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    home,
    ctx,
    server,
    close: async () => {
      // 升级后的 WebSocket 连接不在 HTTP 的连接表里，要先关实时通道，否则 server.close 会一直等。
      await realtimeServer?.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.env.HOME = previous.HOME;
      if (previous.CLAWOPT_DATA_DIR === undefined) delete process.env.CLAWOPT_DATA_DIR;
      else process.env.CLAWOPT_DATA_DIR = previous.CLAWOPT_DATA_DIR;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * 把某个会话的网关连接钉成假网关。
 *
 * 链路里有几处会 `disconnectConnection(sessionId)`（新一轮打断旧一轮时），真实现下
 * 下一次 getConnection 会新建客户端重连；这里让连接表对假网关「删不掉」，效果等价。
 */
export function pinFakeGateway(ctx: any, key: string, fake: unknown): void {
  const connections: Map<string, unknown> & { __fakes?: Map<string, unknown> } = ctx.connections;
  if (!connections.__fakes) {
    const fakes = new Map<string, unknown>();
    const originalGet = connections.get.bind(connections);
    const originalHas = connections.has.bind(connections);
    const originalDelete = connections.delete.bind(connections);
    connections.get = (k: string) => (fakes.has(k) ? fakes.get(k) : originalGet(k));
    connections.has = (k: string) => fakes.has(k) || originalHas(k);
    connections.delete = (k: string) => (fakes.has(k) ? true : originalDelete(k));
    connections.__fakes = fakes;
  }
  connections.__fakes.set(key, fake);
}

export type SseFrame = Record<string, any>;

/** 边读边解析 `data: {...}` 帧；`waitFor` 等到某一帧出现。 */
export function readSse(response: Response) {
  const frames: SseFrame[] = [];
  const waiters: Array<{ predicate: (frame: SseFrame) => boolean; resolve: (frame: SseFrame) => void }> = [];
  let ended = false;
  let endResolve!: () => void;
  const endPromise = new Promise<void>((resolve) => { endResolve = resolve; });

  const pump = (async () => {
    if (!response.body) { ended = true; endResolve(); return; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const frame = JSON.parse(line.slice(6));
          frames.push(frame);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(frame)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(frame);
            }
          }
        }
      }
    } catch {
      // 客户端主动断开
    } finally {
      ended = true;
      endResolve();
    }
  })();

  return {
    frames,
    get ended() { return ended; },
    waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs = 8000): Promise<SseFrame> {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for frame; got ${JSON.stringify(frames)}`)), timeoutMs);
        waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
    end: (timeoutMs = 8000) => Promise.race([
      endPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`stream did not end; got ${JSON.stringify(frames)}`)), timeoutMs)),
    ]),
    pump,
  };
}

export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('waitUntil timed out');
}
