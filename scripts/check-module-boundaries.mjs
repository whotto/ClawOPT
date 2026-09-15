#!/usr/bin/env node
/**
 * 后端模块边界检查（无依赖）。
 *
 * P0 把 backend/src/index.ts 拆成了模块。拆完那一刻边界是干净的；
 * 没有机械检查的话，下一个图省事的 `import ... from '../../core/db/db'` 就会让它慢慢糊回去。
 *
 * ## 模块怎么划
 *
 * - `core/<子目录>`、`collab/<子目录>` 各算一个模块（core/db、collab/rooms……）；
 * - 其余顶层目录各算一个模块（openclaw、runtime、control、workspace、bootstrap）；
 * - `src/index.ts` 是入口。
 *
 * ## 规则
 *
 * 1. **跨模块只能经 barrel**：从别的模块导入，路径必须落在对方的 `index.ts` 上
 *    （写成目录名即可），不许直接伸进对方的内部文件。
 * 2. **core 不依赖业务**：`core/*` 不得导入 openclaw / runtime / control / workspace / collab / bootstrap。
 * 3. **服务不引用路由**：`*-routes.ts` 只能被 bootstrap、入口、本模块 barrel 或别的路由文件导入；
 *    经 barrel 取路由注册函数也算（按 barrel 的再导出追到来源文件）。
 * 4. **bootstrap 只归入口用**：除 `src/index.ts` 外谁都不许导入 bootstrap。
 *
 * `import type` 同样受约束：类型依赖也是依赖，边界糊掉往往就从一个「只是类型」开始。
 *
 * 用法：node scripts/check-module-boundaries.mjs [--root <srcDir>]（默认 backend/src）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const rootArg = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : null;
const SRC = path.resolve(rootArg ? path.resolve(process.cwd(), rootArg) : path.join(REPO, 'backend', 'src'));

const BUSINESS_MODULES = new Set(['openclaw', 'runtime', 'control', 'workspace', 'collab', 'automation', 'bootstrap', 'voice', 'memory', 'mcp-server']);

function listTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const rel = (abs) => path.relative(SRC, abs).split(path.sep).join('/');

function moduleOf(relPath) {
  const parts = relPath.split('/');
  if (parts.length === 1) return '<entry>';
  if ((parts[0] === 'core' || parts[0] === 'collab') && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

const isRouteFile = (relPath) => /-routes\.ts$/.test(relPath);

/**
 * 把注释抹成空格（保留换行与字符串），并记下字符串字面量的区间——
 * 注释里、字符串里出现的 `import ... from` 都不是真导入。
 */
function stripComments(code) {
  let out = '';
  let i = 0;
  const stringRanges = [];
  let stringStart = -1;
  const stack = []; // 模板字符串 `${` 嵌套
  let quote = null;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (quote === '`' && ch === '$' && next === '{') { out += next; stack.push('`'); quote = null; stringRanges.push([stringStart, i]); i += 2; continue; }
      if (ch === quote) { quote = null; stringRanges.push([stringStart, i]); }
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  ';
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; stringStart = i; out += ch; i += 1; continue; }
    if (ch === '}' && stack.length && stack[stack.length - 1] === '`') { stack.pop(); quote = '`'; stringStart = i; out += ch; i += 1; continue; }
    if (ch === '}' && stack.length) { stack.pop(); out += ch; i += 1; continue; }
    if (ch === '{' && stack.length) { stack.push('{'); }
    out += ch;
    i += 1;
  }
  return { code: out, inString: (index) => stringRanges.some(([start, end]) => index > start && index < end) };
}

/** 返回 [{ spec, names: string[] | null, line }]。names 为 null 表示整体导入（副作用 / 命名空间 / 动态）。 */
export function parseImports(code) {
  const { code: cleaned, inString } = stripComments(code);
  const lineAt = (index) => cleaned.slice(0, index).split('\n').length;
  const found = [];
  // 导入子句里不会出现 ; = ( ) ——排除它们，正则就不会从 `export const x = ...` 一路吞到后面某个真正的 from。
  const staticRe = /\b(?:import|export)\s+(?:type\s+)?([^;=()'"`]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of cleaned.matchAll(staticRe)) {
    if (inString(match.index)) continue;
    const clause = match[1];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    let names = null;
    if (braces && !/\*/.test(clause)) {
      names = braces[1].split(',').map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean);
      const defaultPart = clause.slice(0, braces.index).replace(/,\s*$/, '').trim();
      if (defaultPart && defaultPart !== 'type') names.push('default');
    }
    found.push({ spec: match[2], names, line: lineAt(match.index) });
  }
  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/g;
  for (const match of cleaned.matchAll(sideEffectRe)) if (!inString(match.index)) found.push({ spec: match[1], names: null, line: lineAt(match.index) });
  const dynamicRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of cleaned.matchAll(dynamicRe)) if (!inString(match.index)) found.push({ spec: match[1], names: null, line: lineAt(match.index) });
  return found;
}

function resolveSpec(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** barrel 的再导出：name → 来源文件（相对 SRC）。 */
const barrelCache = new Map();
function barrelExports(barrelAbs) {
  if (barrelCache.has(barrelAbs)) return barrelCache.get(barrelAbs);
  const map = new Map();
  const { code } = stripComments(fs.readFileSync(barrelAbs, 'utf-8'));
  for (const match of code.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpec(barrelAbs, match[2]);
    if (!target) continue;
    for (const part of match[1].split(',')) {
      const pieces = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const exported = (pieces[1] ?? pieces[0]).trim();
      if (exported) map.set(exported, rel(target));
    }
  }
  for (const match of code.matchAll(/export\s+\*\s+from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpec(barrelAbs, match[1]);
    if (target) map.set(`*${rel(target)}`, rel(target));
  }
  barrelCache.set(barrelAbs, map);
  return map;
}

export function checkModuleBoundaries(srcDir = SRC) {
  const violations = [];
  for (const abs of listTs(srcDir)) {
    const fromRel = rel(abs);
    const fromModule = moduleOf(fromRel);
    const code = fs.readFileSync(abs, 'utf-8');
    for (const { spec, names, line } of parseImports(code)) {
      if (!spec.startsWith('.')) continue;
      const target = resolveSpec(abs, spec);
      const where = `${fromRel}:${line}`;
      if (!target || !target.startsWith(srcDir + path.sep)) {
        if (!target) violations.push(`${where}  无法解析的相对导入 '${spec}'`);
        continue;
      }
      const toRel = rel(target);
      const toModule = moduleOf(toRel);

      if (fromModule.startsWith('core/') && (BUSINESS_MODULES.has(toModule.split('/')[0]) || toModule === '<entry>')) {
        violations.push(`${where}  core 不得依赖业务模块：导入了 ${toModule}（'${spec}'）`);
      }
      if (toModule === 'bootstrap' && fromModule !== 'bootstrap' && fromModule !== '<entry>') {
        violations.push(`${where}  只有入口 src/index.ts 可以导入 bootstrap（'${spec}'）`);
      }
      if (toModule !== fromModule && toModule !== '<entry>') {
        const barrel = toModule === '<entry>' ? null : `${toModule}/index.ts`;
        if (toRel !== barrel) {
          violations.push(`${where}  跨模块导入必须经 barrel：'${spec}' 伸进了 ${toRel}，应改为从 ${toModule} 导入`);
        }
      }

      // 规则 3：路由文件只能被路由文件、bootstrap、入口导入
      // barrel 负责对外公开本模块的注册函数，它转手再导出不算「服务引用路由」。
      const importerMayUseRoutes = isRouteFile(fromRel) || path.basename(fromRel) === 'index.ts' || fromModule === 'bootstrap' || fromModule === '<entry>';
      if (!importerMayUseRoutes) {
        const sources = new Set();
        if (isRouteFile(toRel)) sources.add(toRel);
        if (path.basename(toRel) === 'index.ts') {
          const exportsMap = barrelExports(target);
          if (names === null) {
            for (const source of exportsMap.values()) if (isRouteFile(source)) sources.add(source);
          } else {
            for (const name of names) {
              const source = exportsMap.get(name);
              if (source && isRouteFile(source)) sources.add(source);
            }
          }
        }
        for (const source of sources) {
          violations.push(`${where}  非路由文件不得引用路由文件 ${source}（'${spec}'）`);
        }
      }
    }
  }
  return violations;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (!fs.existsSync(SRC)) {
    console.error(`找不到源码目录：${SRC}`);
    process.exit(2);
  }
  const violations = checkModuleBoundaries(SRC);
  if (violations.length) {
    console.error(`模块边界检查失败（${violations.length} 处）：`);
    for (const violation of violations) console.error(`  ${violation}`);
    process.exit(1);
  }
  console.log(`模块边界检查通过：${path.relative(process.cwd(), SRC) || SRC}`);
}
