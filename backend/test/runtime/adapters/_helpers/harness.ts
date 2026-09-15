/**
 * 适配器用例的公共脚手架：假平台（代理 / MCP / 运行时管理器）、脚本化进程、内存文件系统、
 * 直接驱动一次 `start()` 并收集事件，以及金样文件的路径归一化。
 *
 * 假进程刻意把 `exit` 与 `close` 分开：真子进程里 `exit` 可能先于 stdout 排空，
 * 用例要能造出「exit 已到、最后几行还没读到」的时序。
 */
import fs from 'fs';
import path from 'path';
import type {
  AdapterEvent,
  AdapterRunHandle,
  AdapterRunOutcome,
  AgentRuntimeAdapter,
  CanonicalEvent,
  ProxyMode,
} from '../../../../src/runtime/contract';
import type {
  ManagedMcpServer,
  McpInjector,
  ProviderProxy,
  ProxyTarget,
  RuntimeDescriptor,
  RuntimeManager,
} from '../../../../src/runtime/adapters/_platform-types';
import type { LaunchSpec, ProcessExecutor, ProcessExit, ProcessHandlers, RunningProcess } from '../../../../src/runtime/adapters/_shared/process';
import type { RuntimeFs } from '../../../../src/runtime/adapters/_shared/runtime-fs';
import type { CodingAgentAdapterDeps, CodingAgentRunRequest } from '../../../../src/runtime/adapters/_shared/types';

export const DATA_DIR = '/data/clawopt';
export const USER_HOME = '/home/user';
export const WORKSPACE = '/work/project';

// ---------- 内存文件系统 ----------

export class MemoryFs implements RuntimeFs {
  files = new Map<string, { content: string; mode: number }>();
  dirs = new Set<string>();
  links = new Map<string, string>();
  writes: string[] = [];

  seed(filePath: string, content: string): this {
    this.files.set(filePath, { content, mode: 0o644 });
    this.dirs.add(path.dirname(filePath));
    return this;
  }

  seedDir(dirPath: string): this {
    this.dirs.add(dirPath);
    return this;
  }

  readText(filePath: string) {
    return this.files.get(filePath)?.content ?? null;
  }
  exists(filePath: string) {
    return this.files.has(filePath) || this.dirs.has(filePath) || this.links.has(filePath);
  }
  isDirectory(filePath: string) {
    return this.dirs.has(filePath);
  }
  listDir(dirPath: string) {
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs, ...this.links.keys()]) {
      if (path.dirname(p) === dirPath) names.add(path.basename(p));
    }
    return [...names].sort();
  }
  mkdirp(dirPath: string) {
    this.dirs.add(dirPath);
  }
  writeFile(filePath: string, content: string, mode = 0o600) {
    if (this.links.has(filePath)) throw new Error('refusing to write through symlink');
    this.files.set(filePath, { content, mode });
    this.writes.push(filePath);
  }
  symlink(target: string, linkPath: string) {
    this.links.set(linkPath, target);
  }
  removeFile(filePath: string) {
    this.files.delete(filePath);
  }
}

// ---------- 假平台 ----------

export interface FakeProxy extends ProviderProxy {
  registered: ProxyTarget[];
  revoked: number;
  /** 模拟代理 tee：往某次运行推一个规范事件。 */
  push(runId: string, event: CanonicalEvent): void;
}

export function fakeProxy(): FakeProxy {
  const listeners = new Map<string, Set<(e: CanonicalEvent) => void>>();
  const proxy: FakeProxy = {
    registered: [],
    revoked: 0,
    register(target) {
      proxy.registered.push(target);
      return {
        routeKey: 'route_1',
        token: 'clawopt_proxy_token_abcdefghijkl',
        anthropicBaseUrl: 'http://127.0.0.1:3150/api/claude-code-proxy/route_1',
        responsesBaseUrl: 'http://127.0.0.1:3150/api/codex-proxy/route_1/v1',
        revoke: () => { proxy.revoked += 1; },
      };
    },
    onCanonicalEvent(runId, listener) {
      if (!listeners.has(runId)) listeners.set(runId, new Set());
      listeners.get(runId)!.add(listener);
      return () => listeners.get(runId)?.delete(listener);
    },
    push(runId, event) {
      for (const listener of listeners.get(runId) ?? []) listener(event);
    },
  };
  return proxy;
}

export function fakeMcp(servers: ManagedMcpServer[] = [], excluded: { name: string; reason: string }[] = []): McpInjector & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async resolveForRun(o) {
      calls.push(o);
      return { servers: [...servers, ...o.userServers], excluded };
    },
  };
}

export interface FakeManager extends RuntimeManager {
  missing: boolean;
  updating: boolean;
  runsBegun: number;
  runsEnded: number;
  registered: RuntimeDescriptor[];
  /** 模拟一个把整份进程环境都合并进来的管理器（守卫要能对着它证明会红）。 */
  leakyEnv?: NodeJS.ProcessEnv;
}

export function fakeManager(executablePath = '/usr/local/bin/cli'): FakeManager {
  const manager: FakeManager = {
    missing: false,
    updating: false,
    runsBegun: 0,
    runsEnded: 0,
    registered: [],
    async resolveExecutable() {
      return manager.missing ? { missing: true, messageCode: 'runtime.notInstalled' } : { path: executablePath };
    },
    childEnv(extra) {
      return { ...(manager.leakyEnv ?? {}), PATH: '/usr/local/bin:/usr/bin:/bin', HOME: USER_HOME, LANG: 'en_US.UTF-8', ...extra };
    },
    beginRun() {
      if (manager.updating) {
        const error: any = new Error('Agent is updating; retry after completion');
        error.messageCode = 'runtime.updating';
        throw error;
      }
      manager.runsBegun += 1;
      return () => { manager.runsEnded += 1; };
    },
    register(d) {
      manager.registered.push(d);
    },
  };
  return manager;
}

// ---------- 脚本化进程 ----------

export interface FakeProcess {
  spec: LaunchSpec;
  stdin: string;
  stdinEnded: boolean;
  terminateCalls: number;
  line(text: string | object): void;
  lines(texts: Array<string | object>): void;
  stderr(text: string): void;
  /** 只发 exit（信息性）。 */
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  spawnError(code: string, message: string): void;
  /** 等下一次写 stdin（RPC 类运行时用）。 */
  nextWrite(): Promise<string>;
  onWrite(listener: (data: string) => void): void;
}

export interface ScriptedExecutor {
  executor: ProcessExecutor;
  processes: FakeProcess[];
  /** 下一个起来的进程。 */
  next(): Promise<FakeProcess>;
}

export function scriptedExecutor(options: {
  /** terminate 时自动 close（默认 true，signal SIGINT）。 */
  closeOnTerminate?: boolean;
  onLaunch?: (proc: FakeProcess) => void;
} = {}): ScriptedExecutor {
  const processes: FakeProcess[] = [];
  const waiters: Array<(p: FakeProcess) => void> = [];
  const executor: ProcessExecutor = (spec: LaunchSpec, handlers: ProcessHandlers): RunningProcess => {
    let resolveClosed!: (exit: ProcessExit) => void;
    const closed = new Promise<ProcessExit>((resolve) => { resolveClosed = resolve; });
    let isClosed = false;
    const writeListeners: Array<(d: string) => void> = [];
    const pendingWrites: Array<(d: string) => void> = [];
    let stderrTail = '';
    const proc: FakeProcess = {
      spec,
      stdin: '',
      stdinEnded: false,
      terminateCalls: 0,
      line: (text) => { if (!isClosed) handlers.onStdoutLine(typeof text === 'string' ? text : JSON.stringify(text)); },
      lines: (texts) => { for (const t of texts) proc.line(t); },
      stderr: (text) => { stderrTail += text; handlers.onStderr?.(text); },
      exit: (code, signal = null) => handlers.onExit?.({ code, signal }),
      close: (code, signal = null) => {
        if (isClosed) return;
        isClosed = true;
        resolveClosed({ code, signal });
      },
      spawnError: (code, message) => {
        if (isClosed) return;
        isClosed = true;
        resolveClosed({ code: null, signal: null, spawnError: { code, message } });
      },
      nextWrite: () => new Promise((resolve) => pendingWrites.push(resolve)),
      onWrite: (listener) => writeListeners.push(listener),
    };
    const running: RunningProcess = {
      pid: 4242,
      write: (data) => {
        proc.stdin += data;
        for (const l of writeListeners) l(data);
        const waiter = pendingWrites.shift();
        waiter?.(data);
        return true;
      },
      endStdin: () => { proc.stdinEnded = true; },
      terminate: () => {
        proc.terminateCalls += 1;
        if (options.closeOnTerminate !== false) setImmediate(() => proc.close(null, 'SIGINT'));
        return closed;
      },
      closed,
      stderrTail: () => stderrTail,
    };
    processes.push(proc);
    const waiter = waiters.shift();
    if (waiter) waiter(proc);
    options.onLaunch?.(proc);
    return running;
  };
  return {
    executor,
    processes,
    next: () => {
      const already = processes.find((p) => !(p as any).__taken);
      if (already) {
        (already as any).__taken = true;
        return Promise.resolve(already);
      }
      return new Promise((resolve) => waiters.push((p) => { (p as any).__taken = true; resolve(p); }));
    },
  };
}

// ---------- 驱动一次运行 ----------

export interface Harness {
  deps: CodingAgentAdapterDeps;
  fs: MemoryFs;
  proxy: FakeProxy;
  mcp: ReturnType<typeof fakeMcp>;
  manager: FakeManager;
  exec: ScriptedExecutor;
  logs: Array<{ level: string; message: string; detail?: unknown }>;
}

export function harness(options: {
  executorOptions?: Parameters<typeof scriptedExecutor>[0];
  mcpServers?: ManagedMcpServer[];
  processEnv?: NodeJS.ProcessEnv;
  executablePath?: string;
} = {}): Harness {
  const memFs = new MemoryFs();
  const proxy = fakeProxy();
  const mcp = fakeMcp(options.mcpServers ?? []);
  const manager = fakeManager(options.executablePath);
  const exec = scriptedExecutor(options.executorOptions);
  const logs: Harness['logs'] = [];
  let uuidSeq = 0;
  const deps: CodingAgentAdapterDeps = {
    proxy,
    mcp,
    manager,
    executor: exec.executor,
    dataDir: DATA_DIR,
    logger: {
      info: (message, detail) => logs.push({ level: 'info', message, detail }),
      warn: (message, detail) => logs.push({ level: 'warn', message, detail }),
    },
    fs: memFs,
    homeDir: USER_HOME,
    processEnv: options.processEnv ?? { PATH: '/usr/bin', HOME: USER_HOME, SECRET_TOKEN: 'leak-me', OPENAI_API_KEY: 'sk-user-openai-key-000000' },
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
    now: () => Date.parse('2026-09-15T00:00:00Z'),
  };
  return { deps, fs: memFs, proxy, mcp, manager, exec, logs };
}

export function baseRequest(over: Partial<CodingAgentRunRequest> = {}): CodingAgentRunRequest {
  return {
    mode: 'global',
    prompt: 'reply with ok',
    workspace: WORKSPACE,
    conversation: { kind: 'session', sessionKey: 'session:s1' },
    sessionId: '11111111-1111-4111-8111-111111111111',
    resume: false,
    ...over,
  };
}

export const SCOPED_PROVIDER = {
  provider: 'deepseek',
  model: 'deepseek-v4',
  baseUrl: 'https://api.deepseek.example/v1',
  apiKey: 'sk-upstream-secret-key-123456789',
  apiMode: 'chat_completions' as const,
  contextWindow: 200000,
};

export interface StartedRun {
  events: AdapterEvent[];
  handle: AdapterRunHandle;
  abort: AbortController;
  done: Promise<AdapterRunOutcome>;
  canonical(channel?: AdapterEvent['channel']): CanonicalEvent[];
  types(): string[];
}

export function startRun(
  adapter: AgentRuntimeAdapter<CodingAgentRunRequest>,
  request: CodingAgentRunRequest,
  options: { proxyMode?: ProxyMode; runId?: string } = {},
): StartedRun {
  const events: AdapterEvent[] = [];
  const abort = new AbortController();
  const handle = adapter.start({
    runId: options.runId ?? 'run_1',
    runMarker: 'marker_1',
    sessionKey: 'session:s1',
    agentId: 'agent-1',
    request,
    proxyMode: options.proxyMode ?? request.mode,
    signal: abort.signal,
    emit: (event) => events.push(event),
  });
  return {
    events,
    handle,
    abort,
    done: handle.done,
    canonical: (channel) => events.filter((e) => !channel || e.channel === channel).map((e) => e.event),
    types: () => events.map((e) => e.event.type),
  };
}

export function readFixtureLines(runtimeDir: string, name: string): string[] {
  return fs.readFileSync(path.join(__dirname, '..', runtimeDir, 'fixtures', name), 'utf8').split('\n').filter(Boolean);
}

export function goldenPath(runtimeDir: string, name: string): string {
  return path.join(__dirname, '..', runtimeDir, '__golden__', name);
}

/** 金样：把一次准备的产物（文件、参数、环境）序列化成稳定文本。 */
export function renderLaunch(input: { files: Array<{ path: string; content: string; mode?: number }>; spec: LaunchSpec; stdin?: string }): string {
  const lines: string[] = [];
  lines.push(`$ ${input.spec.command}`);
  for (const arg of input.spec.args) lines.push(`  ${JSON.stringify(arg)}`);
  lines.push(`cwd: ${input.spec.cwd}`);
  lines.push(`stdin: ${input.spec.stdin}`);
  lines.push('env:');
  for (const name of Object.keys(input.spec.env).sort()) lines.push(`  ${name}=${input.spec.env[name]}`);
  if (input.stdin !== undefined) lines.push(`stdin-data: ${JSON.stringify(input.stdin)}`);
  for (const file of [...input.files].sort((a, b) => a.path.localeCompare(b.path))) {
    lines.push('', `--- ${file.path} (${(file.mode ?? 0o600).toString(8)})`, file.content.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

export function writtenFiles(memFs: MemoryFs, prefix: string) {
  return [...memFs.files.entries()]
    .filter(([p]) => p.startsWith(prefix) && !p.endsWith('.clawopt-session.json'))
    .map(([p, v]) => ({ path: p, content: v.content, mode: v.mode }));
}

export async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
