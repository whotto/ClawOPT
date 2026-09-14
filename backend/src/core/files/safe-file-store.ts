/**
 * SafeFileStore：按路径排队的文件读写。
 *
 * `config-atomic-write.ts` 解决的是「一次写入」的原子性——读者看不到半截文件。
 * 它不解决「读—改—写」的原子性：两个请求同时读到同一份 openclaw.json、各改一处、
 * 先后写回，后写的那个会**悄悄覆盖**先写的改动。文件内容永远完整，却少了一次修改，
 * 这是最难查的那类丢数据。这个模块补的是这一层。
 *
 * ## 四件事
 *
 * 1. **进程内按绝对路径排队**。同一文件（按 realpath 归一，软链与原路径算一个）
 *    的更新串行执行；`update()` 的 updater 在锁内读到的是最新内容。
 * 2. **跨进程咨询锁**。同目录 `.<文件名>.lock`，`open(..., 'wx')` 独占创建，
 *    内容记 pid / 主机 / 令牌。持锁进程已死（`kill(pid, 0)` 报 ESRCH）或锁超过
 *    `staleLockMs` 视为残留，清掉重来。CLI 脚本与后端同时改配置时靠它互斥。
 * 3. **原子写 + 可选 `.bak`**。写入复用 `writeFileAtomicSync`（同目录临时文件 + fsync +
 *    rename，保留权限位，穿透软链），不另起一套实现。
 * 4. **多文件事务**。按排序后的路径依次加锁（固定顺序，不会死锁）；事务里只能写
 *    已加锁的路径；逐个落盘途中任何一个失败，已写的按快照回滚，然后把原错误抛出去。
 *
 * ## 同步写
 *
 * 现有的 openclaw.json 写入点全是同步的。`writeFileSync` / `writeJsonSync` 是它们的
 * 直接替代：拿跨进程锁 → 原子写 → 放锁，语义与 `writeJsonAtomicSync` 相同。
 * 同步调用没法等一个 Promise，所以若该路径上正有异步更新在排队或执行，同步写**直接抛**
 * `files.lockBusy`，而不是插队覆盖对方锁内读到的内容。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { writeFileAtomicSync } from './config-atomic-write';

export class SafeFileStoreError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SafeFileStoreError';
    this.errorCode = errorCode;
    if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause;
  }
}

export type UpdateDecision<T, R> = { next: T; result?: R } | { abort: true; result?: R };
export type Updater<T, R> = (current: T | null) => UpdateDecision<T, R> | Promise<UpdateDecision<T, R>>;
export type UpdateResult<R> = { written: boolean; result: R | undefined };

export type WriteOptions = {
  /** 覆盖已有文件前，把旧内容原子地写到 `<文件>.bak`。 */
  backup?: boolean;
};

export type SafeFileStoreOptions = {
  /** 是否加跨进程锁。默认开。 */
  crossProcess?: boolean;
  /** 等锁的上限，超时抛 `files.lockTimeout`。 */
  lockTimeoutMs?: number;
  /** 锁文件超过这个年龄视为残留。 */
  staleLockMs?: number;
  pollIntervalMs?: number;
  /** 测试注入点：实际落盘的函数。默认 `writeFileAtomicSync`。 */
  atomicWrite?: (targetPath: string, contents: string) => void;
};

export type FileTransaction = {
  read(filePath: string): string | null;
  readJson<T = unknown>(filePath: string): T | null;
  write(filePath: string, contents: string): void;
  writeJson(filePath: string, value: unknown): void;
};

type LockInfo = { pid: number; host: string; token: string; acquiredAt: number };

const DEFAULTS = {
  lockTimeoutMs: 10_000,
  staleLockMs: 30_000,
  pollIntervalMs: 25,
};

/** 与 `writeJsonAtomicSync` 同一种序列化，换写入口不改文件字节。 */
function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 文件的锁身份：存在则 realpath；不存在则父目录 realpath + 文件名。 */
export function resolveLockKey(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function lockFilePathFor(key: string): string {
  return path.join(path.dirname(key), `.${path.basename(key)}.lock`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson<T>(filePath: string, text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new SafeFileStoreError('files.jsonParseFailed', `Refusing to update unparsable JSON file: ${filePath}`, { cause: error });
  }
}

export class SafeFileStore {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly options: Required<Omit<SafeFileStoreOptions, 'atomicWrite'>> & { atomicWrite: (p: string, c: string) => void };

  constructor(options: SafeFileStoreOptions = {}) {
    this.options = {
      crossProcess: options.crossProcess ?? true,
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs,
      staleLockMs: options.staleLockMs ?? DEFAULTS.staleLockMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      atomicWrite: options.atomicWrite ?? writeFileAtomicSync,
    };
  }

  /** 读文件（不存在返回 null）。不加锁：原子写保证读者只会看到完整的旧或新内容。 */
  async read(filePath: string): Promise<string | null> {
    return readText(filePath);
  }

  /** 锁内读 → updater 决定写入 `next` 或 `abort` 放弃（不落盘）。 */
  async update<R = void>(filePath: string, updater: Updater<string, R>, writeOptions: WriteOptions = {}): Promise<UpdateResult<R>> {
    return this.withLocks([filePath], async ([key]) => {
      const current = readText(key);
      const decision = await updater(current);
      if ('abort' in decision) return { written: false, result: decision.result };
      this.commitOne(key, current, decision.next, writeOptions);
      return { written: true, result: decision.result };
    });
  }

  /** `update()` 的 JSON 版本。现有内容解析失败时拒绝更新（不拿空对象覆盖一份读不懂的文件）。 */
  async updateJson<T, R = void>(filePath: string, updater: Updater<T, R>, writeOptions: WriteOptions = {}): Promise<UpdateResult<R>> {
    return this.withLocks([filePath], async ([key]) => {
      const currentText = readText(key);
      const decision = await updater(parseJson<T>(key, currentText));
      if ('abort' in decision) return { written: false, result: decision.result };
      this.commitOne(key, currentText, serializeJson(decision.next), writeOptions);
      return { written: true, result: decision.result };
    });
  }

  /**
   * 多文件事务。`fn` 里 `tx.read` 读到的是加锁时的快照，`tx.write` 只暂存；
   * `fn` 正常返回才按路径顺序落盘，途中失败则回滚已写的文件。`fn` 抛错则什么都不写。
   */
  async transaction<R>(filePaths: string[], fn: (tx: FileTransaction) => R | Promise<R>, writeOptions: WriteOptions = {}): Promise<R> {
    return this.withLocks(filePaths, async (keys) => {
      const locked = new Set(keys);
      const snapshots = new Map<string, string | null>();
      for (const key of keys) snapshots.set(key, readText(key));
      const staged = new Map<string, string>();
      const assertLocked = (filePath: string) => {
        const key = resolveLockKey(filePath);
        if (!locked.has(key)) {
          throw new SafeFileStoreError('files.unlockedPathWrite', `Path is not locked by this transaction: ${filePath}`);
        }
        return key;
      };
      const tx: FileTransaction = {
        read: (filePath) => {
          const key = assertLocked(filePath);
          return staged.has(key) ? staged.get(key)! : snapshots.get(key)!;
        },
        readJson: <T>(filePath: string) => {
          const key = assertLocked(filePath);
          return parseJson<T>(key, staged.has(key) ? staged.get(key)! : snapshots.get(key)!);
        },
        write: (filePath, contents) => {
          staged.set(assertLocked(filePath), contents);
        },
        writeJson: (filePath, value) => {
          staged.set(assertLocked(filePath), serializeJson(value));
        },
      };

      const result = await fn(tx);

      const written: string[] = [];
      try {
        for (const key of keys) {
          if (!staged.has(key)) continue;
          this.commitOne(key, snapshots.get(key)!, staged.get(key)!, writeOptions);
          written.push(key);
        }
      } catch (error) {
        const rollbackFailures: string[] = [];
        for (const key of written.reverse()) {
          try {
            const original = snapshots.get(key)!;
            if (original === null) fs.rmSync(key, { force: true });
            else this.options.atomicWrite(key, original);
          } catch {
            rollbackFailures.push(key);
          }
        }
        if (rollbackFailures.length) {
          throw new SafeFileStoreError(
            'files.transactionRollbackFailed',
            `Transaction failed and could not be rolled back for: ${rollbackFailures.join(', ')}`,
            { cause: error },
          );
        }
        throw error;
      }
      return result;
    });
  }

  /** 同步原子写，带跨进程锁。现有同步写入点的直接替代。 */
  writeFileSync(filePath: string, contents: string, writeOptions: WriteOptions = {}): void {
    const key = resolveLockKey(filePath);
    if (this.tails.has(key)) {
      throw new SafeFileStoreError('files.lockBusy', `An async update is in progress for ${filePath}`);
    }
    const release = this.options.crossProcess ? this.acquireProcessLockSync(key) : () => {};
    try {
      this.commitOne(key, writeOptions.backup ? readText(key) : null, contents, writeOptions);
    } finally {
      release();
    }
  }

  writeJsonSync(filePath: string, value: unknown, writeOptions: WriteOptions = {}): void {
    this.writeFileSync(filePath, serializeJson(value), writeOptions);
  }

  /** 这个路径上是否有异步操作在排队或执行（测试与诊断用）。 */
  isBusy(filePath: string): boolean {
    return this.tails.has(resolveLockKey(filePath));
  }

  private commitOne(key: string, current: string | null, next: string, writeOptions: WriteOptions): void {
    if (writeOptions.backup && current !== null) {
      this.options.atomicWrite(`${key}.bak`, current);
    }
    this.options.atomicWrite(key, next);
  }

  private async withLocks<R>(filePaths: string[], fn: (keys: string[]) => Promise<R>): Promise<R> {
    const keys = [...new Set(filePaths.map(resolveLockKey))].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of keys) releases.push(await this.acquireLocal(key));
      if (this.options.crossProcess) {
        for (const key of keys) releases.push(await this.acquireProcessLock(key));
      }
      return await fn(keys);
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  private async acquireLocal(key: string): Promise<() => void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    return () => {
      unlock();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  private tryCreateLock(key: string): (() => void) | null {
    const lockPath = lockFilePathFor(key);
    const info: LockInfo = { pid: process.pid, host: os.hostname(), token: crypto.randomUUID(), acquiredAt: Date.now() };
    let fd: number;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
    try {
      fs.writeSync(fd, JSON.stringify(info));
    } finally {
      fs.closeSync(fd);
    }
    return () => {
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockInfo;
        if (current.token === info.token) fs.rmSync(lockPath, { force: true });
      } catch {
        // 锁文件已不在（被判残留清掉）或读不懂：都不是我们的了，不动它。
      }
    };
  }

  /** 残留判据：持锁进程在本机且已死，或锁文件年龄超过 staleLockMs。 */
  private clearIfStale(key: string): boolean {
    const lockPath = lockFilePathFor(key);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      return true; // 刚好被释放，直接重试
    }
    let info: Partial<LockInfo> = {};
    try {
      info = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      // 写到一半的锁文件：交给年龄判据
    }
    const age = Date.now() - stat.mtimeMs;
    const deadOwner = info.host === os.hostname() && typeof info.pid === 'number' && !isProcessAlive(info.pid);
    if (deadOwner || age > this.options.staleLockMs) {
      fs.rmSync(lockPath, { force: true });
      return true;
    }
    return false;
  }

  private acquireProcessLockSync(key: string): () => void {
    const deadline = Date.now() + this.options.lockTimeoutMs;
    for (;;) {
      const release = this.tryCreateLock(key);
      if (release) return release;
      if (this.clearIfStale(key)) continue;
      if (Date.now() >= deadline) {
        throw new SafeFileStoreError('files.lockTimeout', `Timed out waiting for file lock: ${key}`);
      }
      sleepSync(this.options.pollIntervalMs);
    }
  }

  private async acquireProcessLock(key: string): Promise<() => void> {
    const deadline = Date.now() + this.options.lockTimeoutMs;
    for (;;) {
      const release = this.tryCreateLock(key);
      if (release) return release;
      if (this.clearIfStale(key)) continue;
      if (Date.now() >= deadline) {
        throw new SafeFileStoreError('files.lockTimeout', `Timed out waiting for file lock: ${key}`);
      }
      await sleep(this.options.pollIntervalMs);
    }
  }
}

/**
 * 进程内共享的实例。按路径排队只有在「大家用同一张锁表」时才有意义，
 * 所以写 `~/.openclaw/openclaw.json` 的地方都经它。
 */
export const sharedFileStore = new SafeFileStore();
