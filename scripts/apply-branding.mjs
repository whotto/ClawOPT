#!/usr/bin/env node
/**
 * 品牌改造：从 branding.json 读取，批量替换标识符。可重复执行（幂等）。
 *
 * 为什么不直接 sed：
 *   clawui 同时是 npm 包名 / systemd 服务名 / 数据目录 / SQLite 文件名 /
 *   localStorage 键 / 环境变量前缀。无脑替换会漏掉大小写变体和 URL，
 *   而漏掉 systemd 服务名会导致改造版和原版无法在同一台机器共存。
 *
 * 用法：node scripts/apply-branding.mjs [--dry]
 */
import fs from 'fs';
import path from 'path';
import url from 'url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const B = JSON.parse(fs.readFileSync(path.join(ROOT, 'branding.json'), 'utf8'));

// 顺序敏感：长串在前，避免被短串先吃掉
// 历史 slug（本项目改过名的话，把旧值列在这里，脚本就能从旧名继续迁移）
const LEGACY_SLUGS = ['clawui', 'optlobster'];
const LEGACY_DISPLAY = ['ClawUI', 'OpenClaw Chat Gateway', 'OPT Lobster', 'OPT 龙虾', 'OPT 龍蝦', 'OPT Team'];
const LEGACY_WORDMARK = ['CHAT GATEWAY', 'Chat Gateway', 'OPT TEAM'];
const LEGACY_ENV = ['CLAWUI', 'OPTLOBSTER'];
const LEGACY_REPO = ['OpenClaw-Chat-Gateway', 'OPT-Lobster'];
const LEGACY_OWNER = ['liandu2024', 'YOUR_GITHUB_ORG'];

function legacyRules() {
  const out = [];
  for (const r of LEGACY_REPO) if (r !== B.repoName) out.push([new RegExp(r, 'g'), B.repoName]);
  for (const o of LEGACY_OWNER) if (o !== B.repoOwner) out.push([new RegExp(o, 'g'), B.repoOwner]);
  for (const e of LEGACY_ENV) if (e !== B.envPrefix) {
    out.push([new RegExp(`\\b${e}_`, 'g'), `${B.envPrefix}_`]);
    out.push([new RegExp(`\\b${e}\\b`, 'g'), B.envPrefix]);
  }
  for (const g of LEGACY_SLUGS) if (g !== B.slug) {
    out.push([new RegExp(`\\.${g}_release`, 'g'), `.${B.slug}_release`]);
    out.push([new RegExp(`\\.${g}_dev`, 'g'), `.${B.slug}_dev`]);
    out.push([new RegExp(`\\.${g}-build\\.json`, 'g'), `.${B.slug}-build.json`]);
    out.push([new RegExp(`\\.${g}\\b`, 'g'), `.${B.slug}`]);
    out.push([new RegExp(`${g}\\.service`, 'g'), `${B.serviceName}.service`]);
    out.push([new RegExp(`${g}\\.sqlite`, 'g'), `${B.slug}.sqlite`]);
    out.push([new RegExp(`${g}\\.db`, 'g'), `${B.slug}.db`]);
    out.push([new RegExp(`${g}_back\\.log`, 'g'), `${B.slug}_back.log`]);
    out.push([new RegExp(`${g}-(models\\.json|backend|frontend|update-phase|assets-v)`, 'g'), `${B.slug}-$1`]);
    out.push([new RegExp(`${g}_`, 'g'), `${B.slug}_`]);
    out.push([new RegExp(`\\b${g}\\b`, 'g'), B.slug]);
  }
  for (const d of LEGACY_DISPLAY) if (d !== B.displayNameEn) out.push([new RegExp(d, 'g'), B.displayNameEn]);
  for (const w of LEGACY_WORDMARK) out.push([new RegExp(w, 'g'), B.wordmark || B.displayNameEn.toUpperCase()]);
  return out;
}

const RULES = [
  // ── 回连原作者仓库的 URL（功能性问题，不改会拉到上游的更新脚本）──
  [/https:\/\/raw\.githubusercontent\.com\/liandu2024\/OpenClaw-Chat-Gateway/g,
   `https://raw.githubusercontent.com/${B.repoOwner}/${B.repoName}`],
  [/https:\/\/github\.com\/liandu2024\/OpenClaw-Chat-Gateway/g,
   `https://github.com/${B.repoOwner}/${B.repoName}`],
  [/liandu2024\/OpenClaw-Chat-Gateway/g, `${B.repoOwner}/${B.repoName}`],
  [/\bliandu2024\b/g, B.repoOwner],

  // ── 仓库名 / 安装目录 ──
  [/OpenClaw-Chat-Gateway/g, B.repoName],

  // ── 环境变量前缀（大写）──
  [/\bCLAWUI_/g, `${B.envPrefix}_`],
  [/\bCLAWUI\b/g, B.envPrefix],

  // ── 数据目录（要在通用 clawui 规则之前）──
  [/\.clawui_release/g, `.${B.slug}_release`],
  [/\.clawui_dev/g, `.${B.slug}_dev`],
  [/\.clawui-build\.json/g, `.${B.slug}-build.json`],
  [/\.clawui\b/g, `.${B.slug}`],

  // ── 服务 / 文件名 ──
  [/clawui\.service/g, `${B.serviceName}.service`],
  [/clawui\.sqlite/g, `${B.slug}.sqlite`],
  [/clawui\.db/g, `${B.slug}.db`],
  [/clawui_back\.log/g, `${B.slug}_back.log`],
  [/clawui-models\.json/g, `${B.slug}-models.json`],
  [/clawui-backend/g, `${B.slug}-backend`],
  [/clawui-frontend/g, `${B.slug}-frontend`],
  [/clawui-update-phase/g, `${B.slug}-update-phase`],
  [/clawui-assets-v/g, `${B.slug}-assets-v`],

  // ── localStorage 键（前缀统一）──
  [/clawui_/g, `${B.slug}_`],

  // ── 兜底：剩余的裸 clawui ──
  [/\bClawUI\b/g, B.displayNameEn],
  [/\bclawui\b/g, B.slug],

  // ── 显示名 ──
  [/OpenClaw Chat Gateway/g, B.displayNameEn],
];

const ALL_RULES = [...legacyRules(), ...RULES];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '_upstream-archive']);
const SKIP_FILES = new Set(['branding.json', 'apply-branding.mjs']);
// 归属声明文件：只替换本项目自己的 URL，绝不替换上游作者名
// （否则致谢会变成"基于自己改造自己"，等于抹掉来源）
const ATTRIBUTION_FILES = new Set(['NOTICE', 'LICENSE', 'README.md', 'CHANGELOG.md']);
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.sh', '.service',
                          '.html', '.css', '.yml', '.yaml', '.txt']);

let changed = 0, scanned = 0;
const report = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      continue;
    }
    if (SKIP_FILES.has(e.name)) continue;
    if (e.name.endsWith('package-lock.json')) continue;  // 锁文件不动
    const ext = path.extname(e.name);
    if (ext && !TEXT_EXT.has(ext)) continue;
    const p = path.join(dir, e.name);
    scanned++;
    const before = fs.readFileSync(p, 'utf8');
    let after = before;
    const isAttribution = ATTRIBUTION_FILES.has(e.name);
    for (const [re, to] of ALL_RULES) {
      // 归属文件里跳过"上游作者名"替换规则
      if (isAttribution && /liandu2024|OpenClaw-Chat-Gateway/.test(re.source)) continue;
      after = after.replace(re, to);
    }
    if (after !== before) {
      changed++;
      report.push(path.relative(ROOT, p));
      if (!DRY) fs.writeFileSync(p, after);
    }
  }
}
walk(ROOT);

// 文件重命名
const renames = LEGACY_SLUGS.map(g => [`${g}.service`, `${B.serviceName}.service`]);
for (const [from, to] of renames) {
  const f = path.join(ROOT, from), t = path.join(ROOT, to);
  if (fs.existsSync(f) && from !== to) {
    if (!DRY) fs.renameSync(f, t);
    report.push(`${from} → ${to}`);
  }
}

console.log(`${DRY ? '[预演] ' : ''}扫描 ${scanned} 个文件，改动 ${changed} 个`);
report.forEach(r => console.log('  ·', r));
