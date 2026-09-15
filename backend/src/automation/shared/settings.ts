/**
 * 自动化设置：每次运行的节点并发上限（界面可改），以及主机能力探测的强制降级。
 *
 * ## 低内存判据
 *
 * 生产机是 1.9GB 内存的小主机，并行起两个 Agent 就可能进 swap。判据：
 * - 物理内存总量 < `LOW_MEMORY_TOTAL_BYTES`（3 GiB），或
 * - Linux 上 `/proc/meminfo` 的 MemAvailable < `LOW_MEMORY_AVAILABLE_BYTES`（768 MiB）。
 *
 * 为什么不直接用 `os.freemem()` 判「可用」：Linux 上它是 MemFree（不含可回收的页缓存），
 * macOS 上更是常年只有几百 MB——拿它判会把每台开发机都判成低内存。所以可用量只在能读到
 * MemAvailable 的 Linux 上参与判定，其余平台只看总量。命中任一条，并发强制为 1，界面显示原因。
 */
import fs from 'fs';
import os from 'os';
import type Database from 'better-sqlite3';

export const DEFAULT_MAX_CONCURRENT_NODES = 2;
export const MAX_CONCURRENT_NODES_LIMIT = 8;
export const LOW_MEMORY_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;
export const LOW_MEMORY_AVAILABLE_BYTES = 768 * 1024 * 1024;

export type MemoryProbe = { totalBytes: number; availableBytes: number | null };

export function probeMemory(): MemoryProbe {
  let availableBytes: number | null = null;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
    if (match) availableBytes = Number(match[1]) * 1024;
  } catch {
    availableBytes = null;
  }
  return { totalBytes: os.totalmem(), availableBytes };
}

export function isLowMemory(probe: MemoryProbe): boolean {
  if (probe.totalBytes < LOW_MEMORY_TOTAL_BYTES) return true;
  return probe.availableBytes !== null && probe.availableBytes < LOW_MEMORY_AVAILABLE_BYTES;
}

export function createAutomationSettings(db: Database.Database, memory: () => MemoryProbe = probeMemory) {
  const read = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM automation_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };
  const write = (key: string, value: string) => {
    db.prepare('INSERT INTO automation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  };

  return {
    read,
    write,
    configuredConcurrency(): number {
      const value = Number(read('workflow.maxConcurrentNodes'));
      return Number.isInteger(value) && value >= 1 && value <= MAX_CONCURRENT_NODES_LIMIT ? value : DEFAULT_MAX_CONCURRENT_NODES;
    },
    setConfiguredConcurrency(value: number): void {
      write('workflow.maxConcurrentNodes', String(value));
    },
    effectiveConcurrency(): { configured: number; effective: number; lowMemory: boolean; totalBytes: number; availableBytes: number | null } {
      const probe = memory();
      const configured = this.configuredConcurrency();
      const lowMemory = isLowMemory(probe);
      return { configured, effective: lowMemory ? 1 : configured, lowMemory, totalBytes: probe.totalBytes, availableBytes: probe.availableBytes };
    },
  };
}

export type AutomationSettings = ReturnType<typeof createAutomationSettings>;
