/**
 * node-pty 是**可选**依赖：懒加载，加载不了或起不来伪终端时终端功能关闭并说明原因，不影响服务启动。
 *
 * 本机实测（2026-09-15，node-pty 1.1.0 / npm 11）：npm 11 默认不跑安装脚本，macOS 预编译包里的 `spawn-helper`
 * 没有执行权限，`spawn` 直接报 `posix_spawnp failed`。所以加载时先把执行位补上；
 * 可用性判据是「真起一个伪终端并等它退出」，不是 `require` 成功——require 成功而起不来正是那种情形。
 */
import fs from 'fs';
import path from 'path';

/** 只声明我们用到的 node-pty 形状（依赖是可选的，类型不从包里取）。 */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyProcess;
}

export type PtyLoadResult =
  | { ok: true; pty: PtyModule }
  | { ok: false; reasonCode: 'host.nodePtyMissing' | 'host.nodePtyBroken'; detail: string };

/** macOS 预编译包的 spawn-helper 补执行位（Linux 从源码编译的 build/Release 下同理）。失败不致命，交给后面的真起一次判定。 */
export function repairSpawnHelper(packageDir: string): void {
  const candidates = [
    path.join(packageDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(packageDir, 'build', 'Release', 'spawn-helper'),
  ];
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0o111) fs.chmodSync(candidate, stat.mode | 0o755);
    } catch {
      // 不存在或改不了权限：继续
    }
  }
}

export function loadNodePty(): PtyLoadResult {
  let packageJson: string;
  try {
    packageJson = require.resolve('node-pty/package.json');
  } catch (error) {
    return { ok: false, reasonCode: 'host.nodePtyMissing', detail: (error as Error)?.message?.split('\n')[0] ?? 'node-pty not found' };
  }
  repairSpawnHelper(path.dirname(packageJson));
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pty = require('node-pty') as PtyModule;
    return { ok: true, pty };
  } catch (error) {
    return { ok: false, reasonCode: 'host.nodePtyBroken', detail: (error as Error)?.message?.split('\n')[0] ?? 'node-pty failed to load' };
  }
}

/** 真起一个伪终端跑 `exit 0`，3 秒内退出才算可用。 */
export function probePty(pty: PtyModule, shellPath: string, timeoutMs = 3000): Promise<{ ok: true } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: true } | { ok: false; detail: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: PtyProcess;
    try {
      child = pty.spawn(shellPath, ['-c', 'exit 0'], { name: 'xterm-256color', cols: 20, rows: 5, cwd: '/', env: { PATH: '/usr/bin:/bin' } });
    } catch (error) {
      done({ ok: false, detail: (error as Error)?.message?.split('\n')[0] ?? 'spawn failed' });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done({ ok: false, detail: 'pty probe timed out' });
    }, timeoutMs);
    timer.unref?.();
    child.onData(() => undefined);
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      done(exitCode === 0 ? { ok: true } : { ok: false, detail: `pty probe exited with ${exitCode}` });
    });
  });
}
