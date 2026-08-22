#!/usr/bin/env node
/**
 * 预设装配器：把 presets/<id> 装进正在运行的 ClawOPT。
 *
 * 分两条路，因为 Gateway 的 API 只覆盖一半：
 *   ① POST /api/sessions  —— 建 Agent + 写 6 份 markdown（IDENTITY/SOUL/AGENTS/USER/TOOLS/HEARTBEAT）
 *   ② 直接写工作区目录     —— MEMORY.md / BOOTSTRAP.md / skills/ / reference/ / automations.sh
 *      （API 目前不管这些，见 docs/preset-gap.md）
 *
 * 用法：
 *   node scripts/install-preset.mjs                          交互式
 *   node scripts/install-preset.mjs --preset opt-team --yes   全默认，不问
 *   node scripts/install-preset.mjs --roles ceo-assistant,intel-research
 *   node scripts/install-preset.mjs --dry                     只预演
 *   环境变量：CLAWOPT_URL(默认 http://127.0.0.1:3115)  CLAWOPT_TOKEN  CLAWOPT_WORKSPACE_ROOT
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
import os from 'os';
import readline from 'readline';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = k => argv.includes(k);

const BASE  = (process.env.CLAWOPT_URL || 'http://127.0.0.1:3115').replace(/\/$/, '');
const TOKEN = process.env.CLAWOPT_TOKEN || '';
const DRY   = has('--dry');
const YES   = has('--yes');
const WS_ROOT = process.env.CLAWOPT_WORKSPACE_ROOT || path.join(os.homedir(), '.openclaw');

const C = { g:'\x1b[32m', y:'\x1b[33m', r:'\x1b[31m', b:'\x1b[34m', d:'\x1b[2m', x:'\x1b[0m' };
const log  = (...a) => console.log(...a);
const ok   = m => log(`  ${C.g}✓${C.x} ${m}`);
const warn = m => log(`  ${C.y}⚠${C.x} ${m}`);
const err  = m => log(`  ${C.r}✗${C.x} ${m}`);

async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${data?.error?.code || text.slice(0, 200)}`);
  return data;
}

function ask(rl, q, def) {
  return new Promise(r => rl.question(`  ${q}${def ? ` ${C.d}[${def}]${C.x}` : ''}: `, a => r(a.trim() || def)));
}

function fillPlaceholders(text, vals) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vals ? vals[k] : m));
}

function copyDirFilled(src, dst, vals) {
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) { n += copyDirFilled(s, d, vals); continue; }
    const ext = path.extname(e.name);
    if (['.md', '.sh', '.json', '.txt'].includes(ext)) {
      fs.writeFileSync(d, fillPlaceholders(fs.readFileSync(s, 'utf8'), vals));
    } else fs.copyFileSync(s, d);
    n++;
  }
  return n;
}

(async () => {
  log(`\n${C.b}ClawOPT 预设装配器${C.x}\n`);

  // ── 选预设 ──
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets/manifest.json'), 'utf8'));
  const presetId = arg('--preset', manifest.presets[0].id);
  const pdir = path.join(ROOT, 'presets', presetId);
  if (!fs.existsSync(pdir)) { err(`找不到预设 ${presetId}`); process.exit(1); }
  const P = JSON.parse(fs.readFileSync(path.join(pdir, 'preset.json'), 'utf8'));
  log(`  预设：${C.b}${P.name}${C.x} v${P.version}`);
  log(`  ${C.d}${P.tagline}${C.x}\n`);

  // ── 连通性 ──
  if (!DRY) {
    try { await api('GET', '/api/gateway/status'); ok(`已连上 ${BASE}`); }
    catch (e) {
      err(`连不上 ${BASE} —— ${e.message}`);
      log(`\n  ${C.d}先确认服务在跑：systemctl --user status clawopt${C.x}`);
      log(`  ${C.d}若开了鉴权，设置 CLAWOPT_TOKEN 环境变量${C.x}\n`);
      process.exit(1);
    }
  }

  // ── 选角色 ──
  let roles = P.roles;
  const only = arg('--roles');
  if (only) {
    const want = only.split(',').map(s => s.trim());
    roles = P.roles.filter(r => want.includes(r.id));
    const missing = want.filter(w => !P.roles.some(r => r.id === w));
    if (missing.length) { err(`预设里没有这些角色：${missing.join(', ')}`); process.exit(1); }
  } else if (!YES) {
    roles = P.roles.filter(r => r.recommended);
  }

  // ── 填参数 ──
  const vals = {};
  if (YES || DRY) {
    for (const p of P.params) vals[p.key] = p.default;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log(`\n  ${C.b}填几个参数${C.x} ${C.d}（直接回车用默认值）${C.x}\n`);
    for (const p of P.params) {
      log(`  ${C.d}${p.hint}${C.x}`);
      vals[p.key] = await ask(rl, p.label, p.default);
    }
    log('');
    const list = P.roles.map((r, i) => `${i + 1}. ${r.emoji} ${r.name}${r.recommended ? '' : C.d + '（可选）' + C.x}`).join('\n  ');
    log(`  ${C.b}装哪些角色${C.x}\n  ${list}\n`);
    const pick = await ask(rl, '输入编号，逗号分隔，或 all', roles.map(r => P.roles.indexOf(r) + 1).join(','));
    roles = pick.toLowerCase() === 'all' ? P.roles
          : pick.split(',').map(s => P.roles[parseInt(s.trim(), 10) - 1]).filter(Boolean);
    rl.close();
  }

  log(`\n  将装配 ${C.b}${roles.length}${C.x} 个角色：${roles.map(r => r.emoji + r.name).join('  ')}\n`);
  if (DRY) log(`  ${C.y}[预演模式] 不会写入任何东西${C.x}\n`);

  // ── 逐个装 ──
  const results = [];
  for (const role of roles) {
    const rdir = path.join(pdir, 'roles', role.id);
    log(`${C.b}── ${role.emoji} ${role.name}${C.x} ${C.d}(${role.id})${C.x}`);

    const read = f => { const p = path.join(rdir, f); return fs.existsSync(p) ? fillPlaceholders(fs.readFileSync(p, 'utf8'), vals) : ''; };
    const payload = {
      id: role.id,
      name: role.name,
      identityContent:  read('IDENTITY.md'),
      soulContent:      read('SOUL.md'),
      agentsContent:    read('AGENTS.md'),
      userContent:      read('USER.md'),
      toolsContent:     read('TOOLS.md'),
      heartbeatContent: read('HEARTBEAT.md'),
    };
    const chars = Object.entries(payload)
      .filter(([k]) => k.endsWith('Content'))
      .reduce((a, [, v]) => a + v.length, 0);

    if (DRY) { ok(`API 将写入 6 份 markdown 共 ${chars} 字符`); }
    else {
      try { await api('POST', '/api/sessions', payload); ok(`Agent 已创建，6 份 markdown 共 ${chars} 字符`); }
      catch (e) {
        if (/ALREADY_EXISTS/.test(e.message)) {
          try { await api('PUT', `/api/sessions/${role.id}`, payload); ok(`Agent 已存在 → 已更新配置`); }
          catch (e2) { err(`更新失败：${e2.message}`); results.push([role.id, 'fail']); continue; }
        } else { err(`创建失败：${e.message}`); results.push([role.id, 'fail']); continue; }
      }
    }

    // ── API 覆盖不到的：直接写工作区 ──
    const ws = path.join(WS_ROOT, `workspace-${role.id}`);
    const extras = [];
    for (const f of P.workspaceFiles.files) if (fs.existsSync(path.join(rdir, f))) extras.push(f);
    const dirs = P.workspaceFiles.dirs.filter(d => fs.existsSync(path.join(rdir, d.replace(/\/$/, ''))));
    const scripts = P.workspaceFiles.scripts.filter(s => fs.existsSync(path.join(rdir, s)));

    if (DRY) {
      ok(`工作区将补写：${[...extras, ...dirs, ...scripts].join(' ') || '无'}  ${C.d}→ ${ws}${C.x}`);
    } else {
      fs.mkdirSync(ws, { recursive: true });
      for (const f of extras) fs.writeFileSync(path.join(ws, f), fillPlaceholders(fs.readFileSync(path.join(rdir, f), 'utf8'), vals));
      let cnt = 0;
      for (const d of dirs) cnt += copyDirFilled(path.join(rdir, d.replace(/\/$/, '')), path.join(ws, d.replace(/\/$/, '')), vals);
      for (const s of scripts) { const t = path.join(ws, s); fs.writeFileSync(t, fillPlaceholders(fs.readFileSync(path.join(rdir, s), 'utf8'), vals)); fs.chmodSync(t, 0o755); }
      ok(`工作区补写 ${extras.length} 文件 + ${cnt} 个技能/参考文件  ${C.d}→ ${ws}${C.x}`);
    }
    if (role.externalSkills?.length) warn(`${role.externalSkills.length} 个外部技能需自行安装：roles/${role.id}/skills/EXTERNAL.md`);
    results.push([role.id, 'ok']);
    log('');
  }

  // ── 收尾 ──
  const okN = results.filter(r => r[1] === 'ok').length;
  log(`${C.b}装配完成${C.x}：${okN}/${results.length} 成功\n`);
  log(`${C.b}接下来${C.x}`);
  P.postInstall.forEach((s, i) => log(`  ${i + 1}. ${s}`));
  log(`\n  ${C.d}打开 ${BASE} 就能看到它们了。${C.x}\n`);
})().catch(e => { err(e.message); process.exit(1); });
