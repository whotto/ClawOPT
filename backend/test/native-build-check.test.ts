/**
 * better-sqlite3「GC 时 abort」构建隐患的检测。
 *
 * 真实二进制的对照（2026-09-14，macOS arm64，Node 24.19.0）：
 * - 本机从源码编译的插件含 `__ZN4node10ObjectWrap11CleanupHookEPv`，压测 10 秒内 abort；
 * - 官方预编译包不含该符号，同样压测 30 秒 88 万次迭代不崩。
 * 这里用合成的字节串钉住判据本身，并把启动检查与 harness 脚本的标记钉在一起。
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  BETTER_SQLITE_REBUILD_COMMAND,
  OBJECT_WRAP_CLEANUP_HOOK_MARKER,
  binaryHasObjectWrapCleanupHook,
  inspectBetterSqliteNativeBuild,
  warnIfBetterSqliteNativeBuildHazard,
} from '../src/core/db/native-build-check';

const machO = (symbols: string[]) => Buffer.concat([
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]),
  Buffer.from('\0random bytes\0', 'latin1'),
  ...symbols.map((symbol) => Buffer.from(`${symbol}\0`, 'latin1')),
]);

describe('better-sqlite3 原生插件构建隐患', () => {
  it('源码编译（含 ObjectWrap 清理钩子符号）判为隐患', () => {
    const binary = machO(['__ZN9StatementD2Ev', '__ZN4node10ObjectWrap11CleanupHookEPv']);
    expect(binaryHasObjectWrapCleanupHook(binary)).toBe(true);
    const inspection = inspectBetterSqliteNativeBuild('/fake/better_sqlite3.node', () => binary);
    expect(inspection).toEqual({
      status: 'hazard',
      binaryPath: '/fake/better_sqlite3.node',
      fixCommand: BETTER_SQLITE_REBUILD_COMMAND,
    });
  });

  it('官方预编译包（只有插件自己的 AddEnvironmentCleanupHook）判为正常', () => {
    const binary = machO(['__ZN9StatementD2Ev', '__ZN4node25AddEnvironmentCleanupHookEPN2v87IsolateEPFvPvES3_']);
    expect(binaryHasObjectWrapCleanupHook(binary)).toBe(false);
    expect(inspectBetterSqliteNativeBuild('/fake/ok.node', () => binary).status).toBe('ok');
  });

  it('找不到或读不了插件时是 unknown，不冒充 ok', () => {
    expect(inspectBetterSqliteNativeBuild(null).status).toBe('unknown');
    expect(inspectBetterSqliteNativeBuild('/nope', () => { throw new Error('EACCES'); }).status).toBe('unknown');
  });

  it('有隐患时启动日志带修复命令', () => {
    const lines: string[] = [];
    const warned = warnIfBetterSqliteNativeBuildHazard(
      { status: 'hazard', binaryPath: '/x.node', fixCommand: BETTER_SQLITE_REBUILD_COMMAND },
      (line) => lines.push(line),
    );
    expect(warned).toBe(true);
    expect(lines.join('\n')).toContain('npm rebuild better-sqlite3');
    expect(warnIfBetterSqliteNativeBuildHazard({ status: 'ok', binaryPath: '/x.node' }, (line) => lines.push(line))).toBe(false);
  });

  it('harness 脚本与启动检查用同一个标记（两处判据不许分家）', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'check-native-sqlite.mjs'), 'utf-8');
    expect(script).toContain(`OBJECT_WRAP_CLEANUP_HOOK_MARKER = '${OBJECT_WRAP_CLEANUP_HOOK_MARKER}'`);
    const harness = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'harness-check.mjs'), 'utf-8');
    expect(harness, 'harness:check 没有接上原生插件检查').toContain('scripts/check-native-sqlite.mjs');
  });

  it('DB 构造时真的调用了检查（接线存在）', () => {
    const db = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'core', 'db', 'db.ts'), 'utf-8');
    expect(db).toContain('warnIfBetterSqliteNativeBuildHazard()');
  });
});
