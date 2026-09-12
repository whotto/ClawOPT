/**
 * 本机执行器：把 `BuiltCommand` 真跑起来，把 ndjson 流变成事件。
 *
 * 这是「执行平面」里最薄的一层，也是主机方案唯一会影响到的一层：
 * 扩容现机与本机原型都用这一份；将来若改成跨机调用，换掉的只是这个文件，
 * 命令构造与流解析（`claude-code.ts`）原样不动。
 *
 * 三件容易写错、且都不会报错的事：
 *
 * 1. **跨块的行。** stdout 的分块和行边界毫无关系，一条长回复会在任意字节处
 *    被切开。不做跨块缓冲，两截都解析失败，而用户只看到「它没说话」。
 * 2. **stderr 原文。** 里面可能有绝对路径（含用户名）甚至凭据。它**不能**进
 *    结果对象——那个对象会进日志、进诊断快照、进群消息。
 * 3. **停不掉的进程。** 群里的 `/stop` 必须真的停得住，否则一个跑飞的外部
 *    Agent 会一直占着成员锁。先 SIGTERM 留余地，过了宽限期再 SIGKILL。
 */
import { spawn } from 'child_process';
import { sanitizeErrorDetail } from '../openclaw-config';
import type { BuiltCommand, ExternalAgentAdapter, ExternalRunEvent } from './types';

export interface RunOptions {
  onEvent: (event: ExternalRunEvent) => void;
  /** 整轮上限。外部 Agent 可能跑很久（文档工具首次 bootstrap 就要几分钟），默认给得宽。 */
  timeoutMs?: number;
  /** SIGTERM 之后等多久再 SIGKILL。 */
  graceMs?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  finalText?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
  exitCode: number | null;
  aborted: boolean;
  timedOut: boolean;
  /** 已脱敏的失败原因。**永远不是 stderr 原文。** */
  errorDetail?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_GRACE_MS = 3000;
/** 单行上限。上游若吐出一条畸形的超长行，不能让它把内存吃光。 */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export function runExternalAgent(
  built: BuiltCommand,
  adapter: ExternalAgentAdapter,
  options: RunOptions,
): Promise<RunResult> {
  const { onEvent, timeoutMs = DEFAULT_TIMEOUT_MS, graceMs = DEFAULT_GRACE_MS, signal } = options;

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let sawErrorEvent = false;
    let finalEvent: ExternalRunEvent | undefined;
    let spawnError: string | undefined;
    let buffer = '';

    const child = spawn(built.command, built.args, {
      cwd: built.cwd,
      // stdin 走 /dev/null（'ignore'）。实测不这么做的话，claude 每次要等 3 秒
      // 才放弃读 stdin —— 群聊里每条消息 3 秒，用户感觉得到。
      stdio: [built.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // 不过 shell：参数是数组，引号、$、反引号都无需转义，也就没有注入面。
      shell: false,
      // 单独开一个进程组，这样停的时候能把**整棵子树**一起停掉。
      // 不这么做的话：kill 只打中直接子进程，它派生的孙子进程活下来、继续
      // 持有继承来的 stdout，于是管道不关、'close' 永不触发、这个 Promise
      // 永远不 resolve——群里的成员锁就再也放不掉了。
      // 这条不是推演：用例里假 claude 跑 `sleep 30`，改之前 abort 与 timeout
      // 两条稳定卡到 15 秒超时，现场还留着孤儿 sleep 进程。
      detached: true,
    });

    // 长 prompt 走 stdin（绕开 ARG_MAX）。喂完**必须关闭**——不关的话子进程会
    // 一直等更多输入，这一轮永远不结束，而成员锁要等 15 分钟陈旧接管才放得掉。
    if (built.stdin === 'pipe' && child.stdin) {
      child.stdin.on('error', (error) => {
        // 子进程没读完就退出时会 EPIPE。那不是我们的错，也不该把这一轮拖垮——
        // 真正的失败会从退出码或事件流里反映出来。
        console.warn('[ExternalAgent] 写 stdin 失败：', sanitizeErrorDetail(error));
      });
      child.stdin.end(built.stdinData ?? '');
    }

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    /** 先 SIGTERM 给它收尾的机会，过了宽限期再 SIGKILL。 */
    let killTimer: NodeJS.Timeout | undefined;
    /** 对整个进程组发信号；进程组已经没了就当作已停。 */
    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);   // 负号 = 整个进程组
      } catch {
        try { child.kill(sig); } catch { /* 已经退出 */ }
      }
    };
    const stop = () => {
      if (child.exitCode !== null) return;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null) signalGroup('SIGKILL');
      }, graceMs);
      killTimer.unref?.();
    };

    const onAbort = () => { aborted = true; stop(); };
    if (signal) {
      if (signal.aborted) { aborted = true; }
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timeoutTimer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timeoutTimer.unref?.();

    const handleLine = (line: string) => {
      const event = adapter.parseStreamLine(line);
      if (!event) return;
      if (event.kind === 'final') finalEvent = event;
      if (event.kind === 'error') { sawErrorEvent = true; finalEvent = event; }
      try {
        onEvent(event);
      } catch (error) {
        // 消费方抛错不该把这一轮拖垮——它只是订阅者。
        console.warn('[ExternalAgent] 事件消费方抛错：', sanitizeErrorDetail(error));
      }
    };

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        // 没有换行的超长内容：丢掉缓冲并出声，不静默吞掉。
        console.warn('[ExternalAgent] 单行超过上限，丢弃缓冲');
        buffer = '';
        return;
      }
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });

    // stderr **只用于判断有没有出错，绝不进结果**。里面可能有绝对路径与凭据。
    let sawStderr = false;
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', () => { sawStderr = true; });

    child.on('error', (error) => {
      spawnError = sanitizeErrorDetail(error);
      finish({
        ok: false, exitCode: null, aborted, timedOut, errorDetail: spawnError,
      });
    });

    child.on('close', (code) => {
      // 收尾时把缓冲里剩下的半行也处理掉——最后一行可能没有换行。
      if (buffer.trim()) handleLine(buffer);
      buffer = '';

      const ok = !aborted && !timedOut && code === 0 && !!finalEvent && !sawErrorEvent;

      let errorDetail: string | undefined;
      if (aborted) errorDetail = 'aborted';
      else if (timedOut) errorDetail = 'timeout';
      else if (sawErrorEvent) errorDetail = finalEvent?.detail ?? 'runtimeReportedError';
      else if (code !== 0) errorDetail = `exit ${code}`;
      else if (!finalEvent) errorDetail = 'noFinalEvent';
      // sawStderr 只作为补充线索，**不带内容**。
      if (!ok && !errorDetail && sawStderr) errorDetail = 'stderr';

      finish({
        ok,
        finalText: finalEvent?.text,
        sessionId: finalEvent?.sessionId,
        costUsd: finalEvent?.costUsd,
        durationMs: finalEvent?.durationMs,
        exitCode: code,
        aborted,
        timedOut,
        errorDetail,
      });
    });

    if (aborted) stop();
  });
}
