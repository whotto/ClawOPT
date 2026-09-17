/**
 * 收掉一个终端会话的**整棵进程树**。
 *
 * 只对进程组发信号不够（本机实测）：交互式 shell 开着作业控制，`sleep 300 &` 进了**自己的**进程组，
 * 再 `trap "" HUP` 一下连 SIGHUP 都忽略——杀 `-pid` 与伪终端挂断都碰不到它，关掉标签页后它继续活着。
 * 所以先按 ppid 把后代快照下来（Linux 再并上同一个会话 id 的进程），**先快照再发信号**：父进程一死子进程就被 init 收养，
 * ppid 链就断了。之后对根的进程组 + 每个后代发 SIGHUP，宽限后对还活着的发 SIGKILL。
 */
import { execFileSync } from 'child_process';

type PsRow = { pid: number; ppid: number; sid: number | null };

function readProcessTable(): PsRow[] {
  const linux = process.platform === 'linux';
  const format = linux ? 'pid=,ppid=,sid=' : 'pid=,ppid=';
  let output = '';
  try {
    output = execFileSync('ps', ['-A', '-o', format], { encoding: 'utf8', timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/).map(Number);
    if (parts.length < 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) continue;
    rows.push({ pid: parts[0], ppid: parts[1], sid: linux && Number.isInteger(parts[2]) ? parts[2] : null });
  }
  return rows;
}

/** 根进程的全部后代（不含根）。伪终端子进程是会话首进程，Linux 上同一会话 id 的进程也算。 */
export function listDescendants(rootPid: number, table: PsRow[] = readProcessTable()): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found = new Set<number>();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (child === rootPid || found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  for (const row of table) if (row.sid === rootPid && row.pid !== rootPid) found.add(row.pid);
  return [...found];
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
};

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGHUP 整棵树，`graceMs` 后 SIGKILL 还活着的。`graceMs` 为 0 时直接 SIGKILL（停机路径）。
 * 返回宽限计时器（调用方停机时清掉）。
 */
export function killProcessTree(rootPid: number, options: { graceMs: number; onTimer?: (timer: NodeJS.Timeout) => void; table?: () => PsRow[] }): NodeJS.Timeout | null {
  const descendants = listDescendants(rootPid, options.table ? options.table() : undefined);
  const targets = [rootPid, ...descendants];
  if (options.graceMs <= 0) {
    signal(-rootPid, 'SIGKILL');
    for (const pid of targets) signal(pid, 'SIGKILL');
    return null;
  }
  signal(-rootPid, 'SIGHUP');
  for (const pid of targets) signal(pid, 'SIGHUP');
  const timer = setTimeout(() => {
    signal(-rootPid, 'SIGKILL');
    for (const pid of targets) if (isAlive(pid)) signal(pid, 'SIGKILL');
  }, options.graceMs);
  timer.unref?.();
  options.onTimer?.(timer);
  return timer;
}
