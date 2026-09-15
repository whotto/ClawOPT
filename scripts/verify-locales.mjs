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

/**
 * 同一对象里的重复键。`JSON.parse` 对重复键静默取后者——P5a 时 `control.cron.description`
 * 同时被当成页面说明和表单标签写了两次，后一个把前一个覆盖掉，键集比对照样通过，
 * 页面上显示的却是「描述」两个字。这里按字符扫一遍，逐层记下出现过的键。
 */
export function findDuplicateKeys(text) {
  const duplicates = [];
  const stack = []; // 每层：{ keys: Set, path: string[] } 或 null（数组）
  let expectingKey = false;
  let pendingKey = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { value += text[j + 1]; j += 2; continue; }
        value += text[j];
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (top && expectingKey) {
        if (top.keys.has(value)) duplicates.push([...top.path, value].join('.'));
        top.keys.add(value);
        pendingKey = value;
        expectingKey = false;
      }
      i = j;
      continue;
    }
    if (ch === '{') {
      const parent = stack[stack.length - 1];
      stack.push({ keys: new Set(), path: parent ? [...parent.path, pendingKey ?? '[]'] : [] });
      expectingKey = true;
    } else if (ch === '[') {
      const parent = stack[stack.length - 1];
      stack.push({ keys: new Set(), path: parent ? [...parent.path, pendingKey ?? '[]'] : [], array: true });
      expectingKey = false;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      expectingKey = false;
    } else if (ch === ',') {
      expectingKey = !stack[stack.length - 1]?.array;
    }
  }
  return duplicates;
}

const files = fs.readdirSync(DIR).filter(name => name.endsWith('.json')).sort();
if (!files.includes(`${BASE}.json`)) {
  console.error(`找不到基准语言文件 ${BASE}.json`);
  process.exit(1);
}

const keysByLang = new Map();
let duplicateFound = false;
for (const file of files) {
  const lang = file.replace(/\.json$/, '');
  const text = fs.readFileSync(path.join(DIR, file), 'utf8');
  try {
    keysByLang.set(lang, collectKeys(JSON.parse(text)));
  } catch (error) {
    console.error(`${C.r}✗${C.x} ${file} 不是合法 JSON：${error.message}`);
    process.exit(1);
  }
  const duplicates = findDuplicateKeys(text);
  if (duplicates.length) {
    duplicateFound = true;
    console.error(`${C.r}✗${C.x} ${file} 有重复键（后一个会静默覆盖前一个）：${duplicates.join(', ')}`);
  }
}
if (duplicateFound) process.exit(1);

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
