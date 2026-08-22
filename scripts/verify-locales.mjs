#!/usr/bin/env node
/**
 * 三语键集一致性门。
 *
 * 仓库约定「所有新增用户可见文案必须同时支持 zh-CN / zh-TW / en」，但此前没有任何
 * 机制——少写一个语言不会报错，只会在那个语言下显示原始 key。这个门把约定变成检查。
 *
 * 它只比对键集，不判断译文质量：一份把中文原样抄进 en.json 的翻译能过门，
 * 但过不了人的评审。门的作用是让「漏掉一个语言」这类事故不可能悄悄发生。
 *
 * 用法：node scripts/verify-locales.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'frontend/src/locales');
const BASE = 'zh-CN';

const C = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' };

function collectKeys(value, prefix = '', out = new Set()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    out.add(full);
    collectKeys(child, full, out);
  }
  return out;
}

const files = fs.readdirSync(DIR).filter(name => name.endsWith('.json')).sort();
if (!files.includes(`${BASE}.json`)) {
  console.error(`找不到基准语言文件 ${BASE}.json`);
  process.exit(1);
}

const keysByLang = new Map();
for (const file of files) {
  const lang = file.replace(/\.json$/, '');
  try {
    keysByLang.set(lang, collectKeys(JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))));
  } catch (error) {
    console.error(`${C.r}✗${C.x} ${file} 不是合法 JSON：${error.message}`);
    process.exit(1);
  }
}

const base = keysByLang.get(BASE);
let failed = false;
console.log(`\n基准 ${BASE}：${base.size} 个键\n`);

for (const [lang, keys] of keysByLang) {
  if (lang === BASE) continue;
  const missing = [...base].filter(key => !keys.has(key)).sort();
  const extra = [...keys].filter(key => !base.has(key)).sort();
  if (missing.length === 0 && extra.length === 0) {
    console.log(`  ${C.g}✓${C.x} ${lang}`);
    continue;
  }
  failed = true;
  console.log(`  ${C.r}✗${C.x} ${lang}：缺 ${missing.length}，多 ${extra.length}`);
  for (const key of missing.slice(0, 20)) console.log(`      ${C.d}缺${C.x} ${key}`);
  for (const key of extra.slice(0, 20)) console.log(`      ${C.d}多${C.x} ${key}`);
  const rest = missing.length + extra.length - Math.min(missing.length, 20) - Math.min(extra.length, 20);
  if (rest > 0) console.log(`      ${C.d}…还有 ${rest} 条${C.x}`);
}

if (failed) {
  console.log(`\n${C.r}三语文案不一致。补齐后再提交——漏掉的语言不会报错，只会显示原始 key。${C.x}\n`);
  process.exit(1);
}
console.log(`\n${C.g}三语键集一致。${C.x}\n`);
