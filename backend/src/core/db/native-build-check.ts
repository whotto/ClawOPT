/**
 * better-sqlite3 原生插件的「GC 期 abort」隐患检测。
 *
 * ## 事故
 *
 * 2026-09 在 macOS（Homebrew node@24，v24.19.0）上后端反复崩溃，23 份崩溃报告同一个栈：
 * `Statement::~Statement → node::RemoveEnvironmentCleanupHook → Assertion failed: (env) != nullptr`，
 * 全部发生在 V8 GC 的弱回调里。
 *
 * ## 根因（不是 ClawOPT 的代码）
 *
 * Node 24 后期版本的 `node_object_wrap.h` 让 `ObjectWrap` 在构造时注册、析构时注销环境清理钩子，
 * 这段是**内联进插件**的。插件如果是本机用这版头文件**从源码编译**的（prebuild 下载失败时
 * `node-gyp rebuild` 兜底），Statement 在 GC 弱回调里析构时拿不到当前 Environment，直接 abort。
 * 同版本的官方预编译包没有这段内联代码，同样的压测跑 30 秒、88 万次迭代不崩。
 *
 * 判据因此落在二进制上：插件里出现 `node::ObjectWrap::CleanupHook` 这个符号，
 * 就说明它是用会注册清理钩子的头文件编出来的。符号可能被 strip 掉——那是漏报，不是误报。
 *
 * 修复：`cd backend && npm rebuild better-sqlite3`（prebuild-install 会优先取预编译包）。
 *
 * `scripts/check-native-sqlite.mjs` 用同一个标记做 harness 检查；两处标记由
 * `test/native-build-check.test.ts` 钉在一起，不许分家。
 */
import fs from 'fs';
import path from 'path';

/** `node::ObjectWrap::CleanupHook(void*)` 的 Itanium 修饰名片段（macOS 与 Linux 相同）。 */
export const OBJECT_WRAP_CLEANUP_HOOK_MARKER = 'ObjectWrap11CleanupHook';

export const BETTER_SQLITE_REBUILD_COMMAND = 'cd backend && npm rebuild better-sqlite3';

export type NativeBuildInspection =
  | { status: 'ok'; binaryPath: string }
  | { status: 'hazard'; binaryPath: string; fixCommand: string }
  | { status: 'unknown'; reason: string };

export function binaryHasObjectWrapCleanupHook(binary: Buffer): boolean {
  return binary.includes(OBJECT_WRAP_CLEANUP_HOOK_MARKER, 0, 'latin1');
}

export function resolveBetterSqliteBinaryPath(): string | null {
  try {
    const packageJson = require.resolve('better-sqlite3/package.json');
    const candidate = path.join(path.dirname(packageJson), 'build', 'Release', 'better_sqlite3.node');
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function inspectBetterSqliteNativeBuild(
  binaryPath: string | null = resolveBetterSqliteBinaryPath(),
  read: (file: string) => Buffer = (file) => fs.readFileSync(file),
): NativeBuildInspection {
  if (!binaryPath) return { status: 'unknown', reason: 'binaryNotFound' };
  let binary: Buffer;
  try {
    binary = read(binaryPath);
  } catch {
    return { status: 'unknown', reason: 'binaryUnreadable' };
  }
  return binaryHasObjectWrapCleanupHook(binary)
    ? { status: 'hazard', binaryPath, fixCommand: BETTER_SQLITE_REBUILD_COMMAND }
    : { status: 'ok', binaryPath };
}

/** 启动时调用一次：有隐患就大声说出来并给出修复命令，不阻止启动。 */
export function warnIfBetterSqliteNativeBuildHazard(
  inspection: NativeBuildInspection = inspectBetterSqliteNativeBuild(),
  log: (message: string) => void = (message) => console.error(message),
): boolean {
  if (inspection.status !== 'hazard') return false;
  log(
    `[DB] better-sqlite3 原生插件是用会注册 ObjectWrap 清理钩子的 Node 头文件从源码编译的（${inspection.binaryPath}），`
    + `在 Node ${process.versions.node} 上会在 GC 时 abort（Assertion failed: (env) != nullptr）。`
    + `修复：${inspection.fixCommand}`,
  );
  return true;
}
