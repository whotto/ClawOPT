#!/usr/bin/env node
/**
 * 仓库不变量检查的总入口：npm run harness:check
 *
 *   1. locales:check      三语键集一致
 *   2. boundaries:check   后端模块边界
 *   3. presets:check      预设与角色配置包一致（需要 ../openclaw-agents）
 *   4. native:sqlite      better-sqlite3 原生插件没有「GC 时 abort」的构建隐患（需要已装依赖）
 *
 * 第 3 步依赖仓库外的角色配置包。找不到源目录时**明确跳过并说明原因**，而不是报红——
 * 在没有配置包的机器上（CI、别人的工作副本）报红只会让人学会忽略这道门。
 * 发布前的卡口仍然是 `npm run presets:check` 本身，它找不到源目录会失败。
 *
 * 任何一步失败，最终退出码为 1；每一步都会跑完，一次看到全部问题。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS_SRC = path.resolve(ROOT, process.env.CLAWOPT_PRESETS_SRC || '../openclaw-agents');
const SQLITE_BINARY = path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

const steps = [
  { name: 'locales:check', args: ['scripts/verify-locales.mjs'] },
  { name: 'boundaries:check', args: ['scripts/check-module-boundaries.mjs'] },
  {
    name: 'presets:check',
    args: ['scripts/sync-presets.mjs', '--check', '--src', PRESETS_SRC],
    skipReason: fs.existsSync(PRESETS_SRC)
      ? null
      : `角色配置包源目录不存在：${PRESETS_SRC}（可用 CLAWOPT_PRESETS_SRC 指定）。发布前请在有配置包的机器上跑 npm run presets:check。`,
  },
  {
    name: 'native:sqlite',
    args: ['scripts/check-native-sqlite.mjs'],
    skipReason: fs.existsSync(SQLITE_BINARY)
      ? null
      : `backend 依赖未安装，找不到 better-sqlite3 原生插件：${SQLITE_BINARY}`,
  },
];

const results = [];
for (const step of steps) {
  if (step.skipReason) {
    console.log(`\n── ${step.name} ── 跳过：${step.skipReason}`);
    results.push({ name: step.name, status: 'skipped' });
    continue;
  }
  console.log(`\n── ${step.name} ──`);
  const run = spawnSync(process.execPath, step.args, { cwd: ROOT, stdio: 'inherit' });
  results.push({ name: step.name, status: run.status === 0 ? 'passed' : 'failed' });
}

console.log('\n── harness:check 汇总 ──');
for (const result of results) console.log(`  ${result.status.padEnd(7)}  ${result.name}`);
process.exit(results.some((result) => result.status === 'failed') ? 1 : 0);
