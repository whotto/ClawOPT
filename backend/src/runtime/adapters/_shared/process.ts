/**
 * 进程执行器：适配器唯一允许起子进程的地方，而且是**注入**的。
 *
 * 适配器只产出 `LaunchSpec`（命令、参数、工作目录、环境、stdin 方式），执行交给这里——
 * 本机子进程与将来的远程 relay 是同一个接口，测试注入假进程。
 *
 * 这一层钉死四件事，每一件都是参考实现或本仓库栽过的：
 *
 * 1. **完成以 `close` 为准，不是 `exit`。** `exit` 可能在 stdout 排空之前触发，
 *    最后一行 JSONL（API 错误记录、用量）会丢。`onExit` 只作信息，终态只挂在 `closed` 上。
 * 2. **整个进程组一起停。** detached 起子进程，停的时候对负 pid 发 SIGINT，1.5 秒后仍在就 SIGKILL。
 *    只杀直接子进程的话，孙进程继承着 stdout，管道不关、`close` 永不触发。
 * 3. **严格按 LF 切行。** JSON 字符串里的 U+2028 / U+2029 / 裸 CR 不是行边界（Pi 的 RPC 就吃过这个亏）；
 *    行尾的一个 CR 去掉。UTF-8 按流解码，多字节字符跨块不会被切坏。
 * 4. **stderr 原文不外泄。** 只留脱敏后的尾巴（8 KiB）给错误详情用。
 */
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { sanitizeRuntimeText } from './sanitize';

export const KILL_ESCALATION_MS = 1500;
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const STDERR_TAIL_CHARS = 8 * 1024;

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `ignore` = stdin 接 /dev/null（Claude 不重定向就固定罚 3 秒）；`pipe` = 要写 prompt 或 RPC。 */
  stdin: 'ignore' | 'pipe';
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 起不来（ENOENT / EACCES）时的错误码或脱敏说明。 */
  spawnError?: { code?: string; message: string };
}

export interface ProcessHandlers {
  onStdoutLine(line: string): void;
  onStderr?(chunk: string): void;
  /** 仅供记录：**不要**在这里判完成。 */
  onExit?(exit: ProcessExit): void;
}

export interface RunningProcess {
  readonly pid: number | undefined;
  write(data: string): boolean;
  endStdin(): void;
  /** SIGINT 整个进程组，1.5 秒后仍在就 SIGKILL；stdio 关闭后 resolve。 */
  terminate(): Promise<ProcessExit>;
  /** stdio 全部关闭（`close`）后 resolve；**不会 reject**。 */
  readonly closed: Promise<ProcessExit>;
  /** 脱敏后的 stderr 尾巴。 */
  stderrTail(): string;
}

export type ProcessExecutor = (spec: LaunchSpec, handlers: ProcessHandlers) => RunningProcess;

/** 严格 LF 切行器（导出给测试与非进程的流，例如远程 relay）。 */
export class LineSplitter {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private dropping = false;

  constructor(private readonly onLine: (line: string) => void, private readonly onOverflow?: () => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (this.dropping) {
        this.dropping = false;
      } else {
        this.onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      }
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      // 没有换行的超长内容：丢到下一个 LF 为止，并出声。
      this.buffer = '';
      this.dropping = true;
      this.onOverflow?.();
    }
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer && !this.dropping) {
      const raw = this.buffer;
      this.onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    }
    this.buffer = '';
    this.dropping = false;
  }
}

/** 本机子进程执行器。 */
export function createLocalProcessExecutor(options: { killEscalationMs?: number } = {}): ProcessExecutor {
  const escalationMs = options.killEscalationMs ?? KILL_ESCALATION_MS;

  return (spec, handlers) => {
    let stderrTail = '';
    let closedResolve!: (exit: ProcessExit) => void;
    const closed = new Promise<ProcessExit>((resolve) => { closedResolve = resolve; });
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: [spec.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    const settle = (exit: ProcessExit) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      closedResolve(exit);
    };

    const splitter = new LineSplitter(
      (line) => {
        try { handlers.onStdoutLine(line); } catch { /* 消费方抛错不拖垮这一轮 */ }
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => splitter.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
      try { handlers.onStderr?.(text); } catch { /* 同上 */ }
    });
    child.stdin?.on('error', () => { /* 子进程先退出时 EPIPE：真正的失败会从退出码与事件流反映 */ });

    child.on('exit', (code, signal) => {
      try { handlers.onExit?.({ code, signal }); } catch { /* 仅供记录 */ }
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // spawn 失败时不会有 close；直接收尾。
      if (child.pid === undefined) {
        splitter.end();
        settle({ code: null, signal: null, spawnError: { code: error.code, message: sanitizeRuntimeText(error.message) } });
      }
    });
    child.on('close', (code, signal) => {
      splitter.end();
      settle({ code, signal });
    });

    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch { /* 已退出 */ }
      }
    };

    return {
      pid: child.pid,
      write: (data) => {
        if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
        return child.stdin.write(data);
      },
      endStdin: () => {
        if (child.stdin && !child.stdin.writableEnded) child.stdin.end();
      },
      terminate: () => {
        if (!settled && !killTimer) {
          signalGroup('SIGINT');
          killTimer = setTimeout(() => {
            // 直接子进程退了、孙进程还握着管道时 close 未到：照样 SIGKILL 整个组。
            if (!settled) signalGroup('SIGKILL');
          }, escalationMs);
          killTimer.unref?.();
        }
        return closed;
      },
      closed,
      stderrTail: () => sanitizeRuntimeText(stderrTail),
    };
  };
}
