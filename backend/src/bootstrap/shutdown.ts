/**
 * 优雅停机注册表。
 *
 * 拆分前进程收到 SIGTERM 就地退出：正在写的 SSE 帧被截断、网关 WebSocket 不说再见。
 * 现在停机是一张有名字的步骤表：
 *
 * - 步骤按注册的**逆序**依次关闭（后起来的先关：HTTP 先停止接新请求，再断下游连接）；
 * - 每一步的失败只记步骤名，不影响后续步骤；
 * - 总时限 10 秒：到点还没关完，就对**没关完的步骤**调 `forceClose`，然后以退出码 1 退出；
 *   关完则以 0 退出；
 * - 第二次收到信号直接强制退出——人在终端里连按两次 Ctrl+C 就是不想等了。
 */
export type ShutdownStep = {
  name: string;
  close: () => void | Promise<void>;
  /** 超时后调用，必须同步且尽快返回。 */
  forceClose?: () => void;
};

export type ShutdownRegistryOptions = {
  forceExitMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
};

type SignalSource = {
  on(signal: 'SIGINT' | 'SIGTERM', listener: (signal: NodeJS.Signals) => void): unknown;
};

export const DEFAULT_FORCE_EXIT_MS = 10_000;

export function createShutdownRegistry(options: ShutdownRegistryOptions = {}) {
  const forceExitMs = options.forceExitMs ?? DEFAULT_FORCE_EXIT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? ((message: string) => console.log(message));

  const steps: ShutdownStep[] = [];
  const pending = new Set<ShutdownStep>();
  let inFlight: Promise<void> | null = null;
  let exited = false;

  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };

  const force = (why: string) => {
    log(`[Shutdown] ${why}; forcing ${pending.size} unfinished step(s)`);
    for (const step of [...steps].reverse()) {
      if (!pending.has(step)) continue;
      try {
        step.forceClose?.();
      } catch {
        log(`[Shutdown] forceClose failed: ${step.name}`);
      }
    }
    finish(1);
  };

  function register(step: ShutdownStep): void {
    if (steps.some((existing) => existing.name === step.name)) {
      throw new Error(`Shutdown step "${step.name}" is already registered`);
    }
    steps.push(step);
  }

  function shutdown(reason: string): Promise<void> {
    if (inFlight) return inFlight;
    log(`[Shutdown] ${reason}: closing ${steps.length} step(s)`);
    for (const step of steps) pending.add(step);
    const timer = setTimeout(() => force(`timed out after ${forceExitMs}ms`), forceExitMs);
    timer.unref?.();

    inFlight = (async () => {
      let failed = false;
      for (const step of [...steps].reverse()) {
        try {
          await step.close();
        } catch {
          failed = true;
          log(`[Shutdown] close failed: ${step.name}`);
        }
        pending.delete(step);
      }
      clearTimeout(timer);
      finish(failed ? 1 : 0);
    })();
    return inFlight;
  }

  function installSignalHandlers(source: SignalSource = process): void {
    const onSignal = (signal: NodeJS.Signals) => {
      if (inFlight) {
        force(`received ${signal} again`);
        return;
      }
      void shutdown(`received ${signal}`);
    };
    source.on('SIGINT', onSignal);
    source.on('SIGTERM', onSignal);
  }

  return {
    register,
    shutdown,
    installSignalHandlers,
    stepNames: () => steps.map((step) => step.name),
  };
}

export type ShutdownRegistry = ReturnType<typeof createShutdownRegistry>;
