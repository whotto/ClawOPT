#!/usr/bin/env node
/**
 * better-sqlite3 原生插件隐患检查（harness:check 的一步）。
 *
 * 判据与 backend/src/core/db/native-build-check.ts 相同：插件二进制里出现
 * `node::ObjectWrap::CleanupHook` 符号 = 用 Node 24 后期头文件从源码编译，
 * 在 GC 弱回调里析构 Statement 时会 abort。背景与证据见那个文件的头注释。
 *
 * 用法：node scripts/check-native-sqlite.mjs [--binary <插件路径>]（默认 backend/node_modules 下的那个）
 * 退出码：0 通过 / 1 有隐患 / 2 找不到插件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 与 native-build-check.ts 的 OBJECT_WRAP_CLEANUP_HOOK_MARKER 必须一致（有用例钉住）。
const OBJECT_WRAP_CLEANUP_HOOK_MARKER = 'ObjectWrap11CleanupHook';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const BINARY_PATH = argv.includes('--binary')
  ? path.resolve(argv[argv.indexOf('--binary') + 1])
  : path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

if (!fs.existsSync(BINARY_PATH)) {
  console.log(`找不到 better-sqlite3 原生插件：${BINARY_PATH}（未安装依赖）`);
  process.exit(2);
}
const binary = fs.readFileSync(BINARY_PATH);
if (binary.includes(OBJECT_WRAP_CLEANUP_HOOK_MARKER, 0, 'latin1')) {
  console.error(
    `better-sqlite3 原生插件是从源码编译的、带 ObjectWrap 清理钩子的版本：${BINARY_PATH}\n`
    + `在 Node ${process.versions.node} 上会在 GC 时 abort（Assertion failed: (env) != nullptr）。\n`
    + '修复：cd backend && npm rebuild better-sqlite3',
  );
  process.exit(1);
}
console.log('better-sqlite3 原生插件无 GC 清理钩子隐患。');
