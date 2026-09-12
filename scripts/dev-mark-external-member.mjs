#!/usr/bin/env node
/**
 * 开发用：把某个群成员标成外部运行时，好在真机上验一条往返。
 *
 * UI 还没有这个开关，而按既定顺序 UI 要等执行平面跑起来之后再长——所以先给一条
 * 命令行路径，让「第一条消息在外部 Agent 上走通」这件事不必等界面。
 *
 * **默认 dry-run。** 要落库必须显式加 `--apply`。
 * 理由很直接：它直接改用户的库，而这个库里有全部会话与群消息。一个默认就写的
 * 脚本，早晚会有人在错的库上敲一次。
 *
 * 用法：
 *   node scripts/dev-mark-external-member.mjs --list
 *   node scripts/dev-mark-external-member.mjs --group g1 --member lead-engineer \
 *       --runtime claude-code --workdir ~/projects/app --model claude-sonnet-5 --apply
 *   node scripts/dev-mark-external-member.mjs --group g1 --member lead-engineer \
 *       --runtime openclaw --apply          # 改回去
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function parseArgs(argv) {
  const out = { apply: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--list') out.list = true;
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
  }
  return out;
}

export function resolveDbPath(env = process.env, home = os.homedir()) {
  return path.join(home, env.CLAWOPT_DATA_DIR || '.clawopt', 'clawopt.sqlite');
}

/**
 * 算出这次要做什么，但**不写**。写入与计划分开，是为了让 dry-run 和真写走
 * 同一段逻辑——否则 dry-run 打印的东西和实际会发生的事迟早对不上。
 */
export function planUpdate(members, opts) {
  const target = members.find(
    (m) => m.id === opts.member || m.agent_id === opts.member || m.display_name === opts.member,
  );
  if (!target) {
    return { ok: false, reason: `群里找不到成员「${opts.member}」`, candidates: members.map((m) => m.agent_id) };
  }

  const runtime = opts.runtime || 'claude-code';
  if (runtime === 'openclaw') {
    return {
      ok: true, target, runtime,
      externalConfig: null,
      summary: `${target.display_name}（${target.agent_id}）：${target.runtime || 'openclaw'} → openclaw，并清空 external_config`,
    };
  }

  if (!opts.workdir) {
    return { ok: false, reason: '外部运行时必须给 --workdir：它决定对方能看到哪些文件与哪份项目指令' };
  }
  const requested = path.resolve(opts.workdir.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(requested)) {
    return { ok: false, reason: `工作目录不存在：${requested}` };
  }
  // realpath 一次。macOS 上 /tmp 与 /var 本身就是软链（served-paths.test.ts 为同一个
  // 原因也这么做），而这个路径会作为 cwd 传给子进程——claude 的 system/init 报回来的
  // 是 realpath，两边不归一化就会出现「配置里是 /var/x，运行时说是 /private/var/x」
  // 这种对不上的情况。
  const workingDir = fs.realpathSync(requested);

  const config = { workingDir };
  if (opts.model) config.model = opts.model;
  if (opts.maxBudgetUsd) config.maxBudgetUsd = Number(opts.maxBudgetUsd);

  return {
    ok: true, target, runtime,
    externalConfig: JSON.stringify(config),
    summary: `${target.display_name}（${target.agent_id}）：${target.runtime || 'openclaw'} → ${runtime}\n    工作目录 ${workingDir}${config.model ? `\n    模型 ${config.model}` : ''}`,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath();

  if (!fs.existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}`);
    console.error('提示：开发库通常是 CLAWOPT_DATA_DIR=.clawopt_dev，发布库是 .clawopt_release。');
    process.exit(1);
  }
  console.log(`数据库：${dbPath}\n`);

  const Database = require(path.resolve(process.cwd(), 'backend/node_modules/better-sqlite3'));
  const db = new Database(dbPath);

  if (opts.list || !opts.group) {
    for (const group of db.prepare('SELECT id, name FROM group_chats ORDER BY position').all()) {
      console.log(`群 ${group.id}  ${group.name}`);
      for (const m of db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY position').all(group.id)) {
        console.log(`   ${m.agent_id.padEnd(20)} ${String(m.display_name).padEnd(16)} runtime=${m.runtime || 'openclaw'}`);
      }
    }
    if (!opts.group) console.log('\n给 --group 与 --member 才能修改。');
    return;
  }

  const members = db.prepare('SELECT * FROM group_members WHERE group_id = ?').all(opts.group);
  const plan = planUpdate(members, opts);
  if (!plan.ok) {
    console.error(`不能执行：${plan.reason}`);
    if (plan.candidates) console.error(`该群的成员：${plan.candidates.join('、')}`);
    process.exit(1);
  }

  console.log(`将要修改：\n    ${plan.summary}\n`);
  if (!opts.apply) {
    console.log('这是 dry-run，什么都没写。确认无误后加 --apply。');
    return;
  }

  db.prepare('UPDATE group_members SET runtime = ?, external_config = ? WHERE id = ?')
    .run(plan.runtime, plan.externalConfig, plan.target.id);
  // 切换运行时等于换了一个执行者，旧会话对新执行者没有意义。
  db.prepare('DELETE FROM external_sessions WHERE group_id = ? AND member_id = ?')
    .run(opts.group, plan.target.id);
  console.log('已写入，并清掉了该成员的旧外部会话。');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
