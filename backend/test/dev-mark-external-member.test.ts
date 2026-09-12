/**
 * 开发脚本：把成员标成外部运行时。
 *
 * 它直接改用户的库——库里有全部会话与群消息。所以真正要守的性质只有一条：
 * **默认不写。** 一个默认就写的脚本，早晚有人在错的库上敲一次。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseArgs, planUpdate, resolveDbPath } from '../../scripts/dev-mark-external-member.mjs';

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'dev-mark-external-member.mjs');

let tmpHome: string;
let workdir: string;

const run = (args: string[]) => execFileSync(process.execPath, [SCRIPT, ...args], {
  cwd: REPO,
  env: { ...process.env, HOME: tmpHome, CLAWOPT_DATA_DIR: '.clawopt-devtest' },
  encoding: 'utf-8',
});

async function seed() {
  const prev = process.env.HOME;
  process.env.HOME = tmpHome;
  process.env.CLAWOPT_DATA_DIR = '.clawopt-devtest';
  const mod = await import('../src/db');
  const db = new (mod.default as any)();
  db.saveGroupChat({ id: 'g1', name: '测试群', description: '', position: 0 });
  db.saveGroupMember({ id: 'm1', group_id: 'g1', agent_id: 'lead-engineer', display_name: 'Lead', role_description: '', position: 0 });
  process.env.HOME = prev;
  return db;
}

const readMember = () => {
  const Database = require(path.join(REPO, 'backend/node_modules/better-sqlite3'));
  const db = new Database(path.join(tmpHome, '.clawopt-devtest', 'clawopt.sqlite'));
  const row = db.prepare('SELECT * FROM group_members WHERE id = ?').get('m1');
  db.close();
  return row;
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-devmark-'));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-ws-'));
});
afterEach(() => {
  for (const dir of [tmpHome, workdir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (err) { console.warn('[test] 清理失败：', err); }
  }
});

describe('默认不写', () => {
  it('**不加 --apply 时一个字节都不改**', async () => {
    await seed();
    const out = run(['--group', 'g1', '--member', 'lead-engineer', '--runtime', 'claude-code', '--workdir', workdir]);

    expect(out).toContain('dry-run');
    expect(readMember().runtime, '没加 --apply 却写进去了').toBe('openclaw');
  });

  it('加了 --apply 才落库', async () => {
    await seed();
    run(['--group', 'g1', '--member', 'lead-engineer', '--runtime', 'claude-code', '--workdir', workdir, '--apply']);

    const row = readMember();
    expect(row.runtime).toBe('claude-code');
    expect(JSON.parse(row.external_config).workingDir).toBe(fs.realpathSync(workdir));
  });
});

describe('拒绝而不是猜', () => {
  it('外部运行时缺 --workdir 时拒绝——它决定对方能看到哪些文件', () => {
    const plan = planUpdate([{ id: 'm1', agent_id: 'a', display_name: 'A' }], { member: 'a', runtime: 'claude-code' });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toContain('workdir');
  });

  it('工作目录不存在时拒绝', () => {
    const plan = planUpdate([{ id: 'm1', agent_id: 'a', display_name: 'A' }], {
      member: 'a', runtime: 'claude-code', workdir: '/一定不存在的目录-xyz',
    });
    expect(plan.ok).toBe(false);
  });

  it('找不到成员时列出候选，不随便挑一个', () => {
    const plan = planUpdate(
      [{ id: 'm1', agent_id: 'alpha', display_name: 'A' }, { id: 'm2', agent_id: 'beta', display_name: 'B' }],
      { member: '不存在' },
    );
    expect(plan.ok).toBe(false);
    expect(plan.candidates).toEqual(['alpha', 'beta']);
  });

  it('按 id / agent_id / 显示名三种方式都能定位', () => {
    const members = [{ id: 'm1', agent_id: 'alpha', display_name: '甲' }];
    for (const key of ['m1', 'alpha', '甲']) {
      expect(planUpdate(members, { member: key, runtime: 'openclaw' }).ok, `用 ${key} 定位失败`).toBe(true);
    }
  });
});

describe('改回 openclaw', () => {
  it('清空 external_config，并清掉旧的外部会话', async () => {
    const db = await seed();
    run(['--group', 'g1', '--member', 'lead-engineer', '--runtime', 'claude-code', '--workdir', workdir, '--apply']);
    db.setExternalSession('g1', 'm1', 'some-uuid');

    run(['--group', 'g1', '--member', 'lead-engineer', '--runtime', 'openclaw', '--apply']);

    const row = readMember();
    expect(row.runtime).toBe('openclaw');
    expect(row.external_config).toBeNull();
    // 换了执行者，旧会话对新执行者没有意义。
    expect(db.getExternalSession('g1', 'm1')).toBeNull();
  });
});

describe('参数与路径', () => {
  it('parseArgs 认得标志与键值', () => {
    expect(parseArgs(['--list'])).toMatchObject({ list: true, apply: false });
    expect(parseArgs(['--group', 'g1', '--apply'])).toMatchObject({ group: 'g1', apply: true });
  });

  it('数据库路径跟随 CLAWOPT_DATA_DIR', () => {
    expect(resolveDbPath({ CLAWOPT_DATA_DIR: '.clawopt_dev' }, '/home/u'))
      .toBe('/home/u/.clawopt_dev/clawopt.sqlite');
    expect(resolveDbPath({}, '/home/u')).toBe('/home/u/.clawopt/clawopt.sqlite');
  });
});
