/**
 * 性能监控（P6，spec 07 §2.25）：super_admin 看的一张快照。
 *
 * - 系统：CPU 占用（两次 `os.cpus()` 采样的差值，首轮现采 250 ms）、负载、内存。可用内存判据与主机能力探测一致：
 *   macOS 用 `vm_stat` 的 free + inactive + speculative + purgeable（`os.freemem()` 只算完全空闲页），Linux 用 `/proc/meminfo` 的 MemAvailable；
 * - 本进程：pid、运行时长、RSS / 堆、CPU（`process.cpuUsage` 差值）；
 * - 运行：协调器里的活跃运行按运行时 / Agent / 表面分组，每个会话的排队长度；工作流活跃运行数；
 * - 子进程：`ps` 全表里本进程的**子孙**（外部运行时 CLI、终端 shell、MCP 子进程……），按描述符命令名认出运行时；
 * - 任何一块取不到：那一块给 `error`，整张快照照样返回，**不回 500**（参考实现同样约定）。
 *
 * 只读、不带路径与环境：`ps` 只取 pid / ppid / cpu / rss / etime / comm，命令名只留 basename。
 */
import os from 'os';
import path from 'path';

import { execFilePromise } from '../../core/process';
import { readTextFileSafe } from '../../openclaw';

export type CpuTimes = { idle: number; total: number };

export type ProcessRow = { pid: number; ppid: number; cpuPercent: number; rssKb: number; elapsed: string; command: string };

export type PerformanceSnapshot = {
  takenAt: number;
  system: {
    platform: NodeJS.Platform;
    arch: string;
    uptimeSec: number;
    cpuCount: number;
    cpuPercent: number | null;
    loadAverage: number[];
    memory: { totalBytes: number; availableBytes: number; usedBytes: number; usedPercent: number; source: 'vm_stat' | 'meminfo' | 'os' };
  };
  process: {
    pid: number;
    uptimeSec: number;
    node: string;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    cpuPercent: number | null;
  };
  runs: {
    active: Array<{ sessionKey: string; runtime: string; agentId: string; phase: string; aborting: boolean; startedAt: number; queued: number }>;
    byRuntime: Record<string, number>;
    byAgent: Record<string, number>;
    queuedTotal: number;
    workflowActiveRuns: number | null;
    error: string | null;
  };
  children: { rows: Array<ProcessRow & { runtime: string | null; depth: number }>; totalRssKb: number; error: string | null };
  errors: string[];
};

export type PerformanceDeps = {
  runCoordinator: {
    activeRuns(): Array<{ sessionKey: string; runtime: string; agentId: string; phase: string; aborting: boolean; startedAt: number }>;
    snapshot(sessionKey: string): { queue: unknown[] };
  };
  runtimePlatform: { manager: { descriptors(): Array<{ id: string; command: string }> } };
  automation: { runStore: { listActiveRuns(): unknown[] } };
  /** 以下只给测试注入。 */
  cpus?: () => os.CpuInfo[];
  runCommand?: (file: string, args: string[]) => Promise<string>;
  readText?: (file: string) => string | null;
  platform?: NodeJS.Platform;
  pid?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function cpuTimes(cpus: os.CpuInfo[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle: cpuIdle, irq } = cpu.times;
    idle += cpuIdle;
    total += user + nice + sys + cpuIdle + irq;
  }
  return { idle, total };
}

export function cpuPercentBetween(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 1000) / 10));
}

/** `vm_stat` → 可回收内存字节（与主机能力探测同一判据）。 */
export function parseVmStatAvailable(output: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 0);
  if (!pageSize) return null;
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(output)?.[1] ?? 0);
  return (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize;
}

/** `/proc/meminfo` 的 MemAvailable（kB）→ 字节；没有这一项（很老的内核）返回 null。 */
export function parseMeminfoAvailable(output: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(output);
  return match ? Number(match[1]) * 1024 : null;
}

/** `ps -A -o pid=,ppid=,pcpu=,rss=,etime=,comm=` 的输出。命令名只留 basename（macOS 的 comm 是完整路径）。 */
export function parsePsOutput(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssKb: Number(match[4]),
      elapsed: match[5],
      command: path.basename(match[6]).slice(0, 64),
    });
  }
  return rows;
}

/** 某个 pid 的全部子孙（广度优先，带深度），不含它自己。 */
export function descendantsOf(rows: ProcessRow[], rootPid: number): Array<ProcessRow & { depth: number }> {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const out: Array<ProcessRow & { depth: number }> = [];
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const { pid, depth } = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ ...child, depth: depth + 1 });
      queue.push({ pid: child.pid, depth: depth + 1 });
    }
  }
  return out;
}

const describe = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' ? code : (error as Error)?.name ?? 'Error';
};

export function createPerformanceService(deps: PerformanceDeps) {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const sampleCpus = deps.cpus ?? os.cpus;
  const runCommand = deps.runCommand ?? (async (file: string, args: string[]) => (await execFilePromise(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const readText = deps.readText ?? ((file: string) => {
    const result = readTextFileSafe(file);
    return result.exists && typeof result.value === 'string' ? result.value : null;
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastCpu: { at: number; times: CpuTimes } | null = null;
  let lastProcessCpu: { at: number; usage: NodeJS.CpuUsage } | null = null;

  async function systemCpuPercent(): Promise<number | null> {
    if (!lastCpu) {
      lastCpu = { at: now(), times: cpuTimes(sampleCpus()) };
      await sleep(250);
    }
    const current = cpuTimes(sampleCpus());
    const percent = cpuPercentBetween(lastCpu.times, current);
    lastCpu = { at: now(), times: current };
    return percent;
  }

  function processCpuPercent(): number | null {
    const usage = process.cpuUsage();
    const at = now();
    const previous = lastProcessCpu;
    lastProcessCpu = { at, usage };
    if (!previous || at <= previous.at) return null;
    const micros = (usage.user - previous.usage.user) + (usage.system - previous.usage.system);
    return Math.max(0, Math.round((micros / 1000 / (at - previous.at)) * 1000) / 10);
  }

  async function memory(): Promise<PerformanceSnapshot['system']['memory']> {
    const totalBytes = os.totalmem();
    let availableBytes = os.freemem();
    let source: PerformanceSnapshot['system']['memory']['source'] = 'os';
    if (platform === 'darwin') {
      const available = parseVmStatAvailable(await runCommand('/usr/bin/vm_stat', []).catch(() => ''));
      if (available !== null) {
        availableBytes = Math.min(totalBytes, available);
        source = 'vm_stat';
      }
    } else if (platform === 'linux') {
      const available = parseMeminfoAvailable(readText('/proc/meminfo') ?? '');
      if (available !== null) {
        availableBytes = Math.min(totalBytes, available);
        source = 'meminfo';
      }
    }
    const usedBytes = Math.max(0, totalBytes - availableBytes);
    return { totalBytes, availableBytes, usedBytes, usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0, source };
  }

  function runs(): PerformanceSnapshot['runs'] {
    try {
      const active = deps.runCoordinator.activeRuns().map((run) => ({
        sessionKey: run.sessionKey,
        runtime: run.runtime,
        agentId: run.agentId,
        phase: run.phase,
        aborting: run.aborting,
        startedAt: run.startedAt,
        queued: deps.runCoordinator.snapshot(run.sessionKey).queue.length,
      }));
      const byRuntime: Record<string, number> = {};
      const byAgent: Record<string, number> = {};
      for (const run of active) {
        byRuntime[run.runtime] = (byRuntime[run.runtime] ?? 0) + 1;
        byAgent[run.agentId] = (byAgent[run.agentId] ?? 0) + 1;
      }
      let workflowActiveRuns: number | null = null;
      try {
        workflowActiveRuns = deps.automation.runStore.listActiveRuns().length;
      } catch {
        workflowActiveRuns = null;
      }
      return { active, byRuntime, byAgent, queuedTotal: active.reduce((sum, run) => sum + run.queued, 0), workflowActiveRuns, error: null };
    } catch (error) {
      return { active: [], byRuntime: {}, byAgent: {}, queuedTotal: 0, workflowActiveRuns: null, error: describe(error) };
    }
  }

  async function children(): Promise<PerformanceSnapshot['children']> {
    if (platform === 'win32') return { rows: [], totalRssKb: 0, error: 'unsupported' };
    try {
      const output = await runCommand('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,rss=,etime=,comm=']);
      const commands = new Map<string, string>();
      try {
        for (const descriptor of deps.runtimePlatform.manager.descriptors()) commands.set(path.basename(descriptor.command), descriptor.id);
      } catch {
        // 描述符取不到只影响「认出运行时」这一列。
      }
      const rows = descendantsOf(parsePsOutput(output), pid).map((row) => ({ ...row, runtime: commands.get(row.command) ?? null }));
      return { rows, totalRssKb: rows.reduce((sum, row) => sum + row.rssKb, 0), error: null };
    } catch (error) {
      return { rows: [], totalRssKb: 0, error: describe(error) };
    }
  }

  async function snapshot(): Promise<PerformanceSnapshot> {
    const errors: string[] = [];
    const guard = async <T>(label: string, task: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await task();
      } catch (error) {
        errors.push(`${label}:${describe(error)}`);
        return fallback;
      }
    };
    const [cpuPercent, mem, childRows] = await Promise.all([
      guard('cpu', systemCpuPercent, null),
      guard('memory', memory, { totalBytes: os.totalmem(), availableBytes: os.freemem(), usedBytes: os.totalmem() - os.freemem(), usedPercent: 0, source: 'os' as const }),
      guard('children', children, { rows: [], totalRssKb: 0, error: 'failed' }),
    ]);
    const usage = process.memoryUsage();
    return {
      takenAt: now(),
      system: {
        platform,
        arch: process.arch,
        uptimeSec: Math.round(os.uptime()),
        cpuCount: sampleCpus().length,
        cpuPercent,
        loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100),
        memory: mem,
      },
      process: {
        pid,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        rssBytes: usage.rss,
        heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal,
        externalBytes: usage.external,
        cpuPercent: processCpuPercent(),
      },
      runs: runs(),
      children: childRows,
      errors,
    };
  }

  return { snapshot };
}

export type PerformanceService = ReturnType<typeof createPerformanceService>;
