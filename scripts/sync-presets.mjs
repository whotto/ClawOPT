#!/usr/bin/env node
/**
 * sync-presets.mjs —— 把角色配置包（openclaw-agents）同步进 presets/opt-team/
 *
 * 为什么需要它：presets/opt-team/roles/* 是角色配置包的副本。在此之前这份副本是**手工拷贝**的，
 * 没有任何脚本保证一致。源改了、预设没改，装出来的团队和手上的角色包就分叉了，而且不会报错。
 *
 * 映射：
 *   <src>/0N-<role-id>/   →  presets/opt-team/roles/<role-id>/
 *   <src>/_shared/        →  presets/opt-team/shared/       （不含 _shared/skills/，
 *                                                            各角色已各自带一份技能副本）
 *
 * 用法：
 *   node scripts/sync-presets.mjs                 预演，只打印会改什么
 *   node scripts/sync-presets.mjs --apply         执行
 *   node scripts/sync-presets.mjs --check         只比对，有差异退出码 1（发布前卡口用）
 *   node scripts/sync-presets.mjs --src <path>    指定源目录（默认 ../openclaw-agents）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const C = { b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', x: '\x1b[0m' };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const APPLY = has('--apply');
const CHECK = has('--check');
const SRC = path.resolve(ROOT, val('--src') || '../openclaw-agents');
const DEST = path.join(ROOT, 'presets', 'opt-team');

// 副本里不该出现的东西：源仓库自用的开发文件
const SKIP = new Set(['.git', '.gitignore', '.DS_Store', '__pycache__', 'node_modules']);
const SHARED_SKIP = new Set(['skills']);   // 各角色已带技能副本，shared/ 不重复放


// ── 参数化规则 ──────────────────────────────────────────────────────────
// 预设是**模板**，角色配置包是**填好的实例**。同步时必须把实例里的具体值换回占位符，
// 否则装配器 fillPlaceholders 无从下手，用户填的参数不会生效。
// 新增占位符时在这里加一行，并同步 preset.json 的 params。
const PARAM_RULES = [
  { roles: ['course-design'], from: /老师/g,                                to: '{{USER_TITLE}}' },
  { roles: ['course-design'], from: /https:\/\/qncdn\.n\.cn\/so\/ai_image\/[^\s)]+/g, to: '{{AGENT_AVATAR}}' },
  { roles: '*',               from: /- 一堂创始人 & CEO，创业教育赛道/g,      to: '- {{USER_ROLE}}' },
  { roles: ['biz-insight'],   from: /产品思维强（前去哪儿网、美团产品经理），但\*\*容易从供给端出发\*\*/g,
                              to: '产品思维{{USER_STRENGTH}}，但**{{USER_BLINDSPOT}}**' },
  { roles: ['biz-insight'],   from: /产品思维：强（前去哪儿网、美团产品经理），但容易从供给端出发/g,
                              to: '产品思维：{{USER_STRENGTH}}，但{{USER_BLINDSPOT}}' },
];

const TEXT_EXT = new Set(['.md', '.sh', '.py', '.mjs', '.js', '.json', '.txt', '.html', '.yml', '.yaml']);

function parameterize(buf, roleId, rel) {
  if (!TEXT_EXT.has(path.extname(rel))) return buf;
  let t = buf.toString('utf8');
  for (const r of PARAM_RULES) {
    if (r.roles !== '*' && !r.roles.includes(roleId)) continue;
    t = t.replace(r.from, r.to);
  }
  return Buffer.from(t, 'utf8');
}

const walk = (dir, base = dir, skip = SKIP) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base, SKIP));
    else out.push(path.relative(base, p));
  }
  return out;
};

const readIf = p => (fs.existsSync(p) ? fs.readFileSync(p) : null);

let added = 0, changed = 0, removed = 0, same = 0;

function syncDir(srcDir, destDir, label, topSkip = SKIP, roleId = null) {
  if (!fs.existsSync(srcDir)) { console.log(`  ${C.r}✗${C.x} 源缺失：${srcDir}`); process.exitCode = 1; return; }
  const srcFiles = new Set(walk(srcDir, srcDir, topSkip));
  const destFiles = fs.existsSync(destDir) ? new Set(walk(destDir)) : new Set();

  for (const rel of [...srcFiles].sort()) {
    const raw = fs.readFileSync(path.join(srcDir, rel));
    const s = roleId ? parameterize(raw, roleId, rel) : raw;
    const d = readIf(path.join(destDir, rel));
    if (d === null) {
      added++; console.log(`  ${C.g}+${C.x} ${label}/${rel}`);
    } else if (!s.equals(d)) {
      changed++; console.log(`  ${C.y}~${C.x} ${label}/${rel}`);
    } else { same++; continue; }
    if (APPLY) {
      const t = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, s);
      fs.chmodSync(t, fs.statSync(path.join(srcDir, rel)).mode & 0o777);
    }
  }
  for (const rel of [...destFiles].sort()) {
    if (srcFiles.has(rel)) continue;
    removed++; console.log(`  ${C.r}-${C.x} ${label}/${rel}  ${C.d}(源已无，副本多出来)${C.x}`);
    if (APPLY) fs.rmSync(path.join(destDir, rel));
  }
}

console.log(`\n${C.b}同步预设${C.x}  源 ${C.d}${SRC}${C.x}\n        目标 ${C.d}${DEST}${C.x}`);
console.log(APPLY ? `${C.y}执行模式${C.x}\n` : CHECK ? `${C.d}比对模式${C.x}\n` : `${C.d}预演模式（加 --apply 才写入）${C.x}\n`);

const roleDirs = fs.readdirSync(SRC, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^\d\d-/.test(e.name))
  .map(e => e.name).sort();

if (!roleDirs.length) { console.log(`${C.r}源目录里没有 0N-<role> 形式的角色目录，路径对吗？${C.x}\n`); process.exit(1); }

for (const dir of roleDirs) {
  const id = dir.replace(/^\d\d-/, '');
  syncDir(path.join(SRC, dir), path.join(DEST, 'roles', id), `roles/${id}`, SKIP, id);
}
syncDir(path.join(SRC, '_shared'), path.join(DEST, 'shared'), 'shared', new Set([...SKIP, ...SHARED_SKIP]));

const drift = added + changed + removed;
console.log(`\n${C.b}结果${C.x}：新增 ${added}｜变更 ${changed}｜多余 ${removed}｜一致 ${same}`);

if (!drift) { console.log(`${C.g}预设与角色配置包一致。${C.x}\n`); process.exit(0); }
if (APPLY) { console.log(`${C.g}已同步。别忘了核对 presets/opt-team/preset.json 的 skills 列表。${C.x}\n`); process.exit(0); }
if (CHECK) { console.log(`${C.r}预设与角色配置包不一致 —— 跑一次 node scripts/sync-presets.mjs --apply 再发布。${C.x}\n`); process.exit(1); }
console.log(`${C.d}以上为预演。确认无误后加 --apply。${C.x}\n`);
