/**
 * 配置快照与恢复 —— v1.5.4。
 *
 * ## 这两个脚本买来的教训
 *
 * `update.sh` 失败时会 `git reset --hard` 退回升级前的提交，这条设计得很细致——
 * 连「不回滚的话 systemd 的 Restart=always 会拿着坏产物每 10 秒崩一次」都想到了。
 * 但**它只回滚代码**。而升级链路里的迁移闸门已经跑过 `openclaw doctor --fix`，
 * 把 `openclaw.json` 从 `agents.list` 迁成了 `agents.entries`。
 *
 * 于是「回滚成功」之后的真实状态是：**1.x 的代码，配 2.x 的配置**。
 * 名册门面的策略是「跟随现状、不主动迁移」，所以回滚后的旧代码会老老实实去读
 * `entries`——可能碰巧还能跑，也可能不能，而这条路径此前没有任何测试覆盖过。
 *
 * 恢复脚本单独成一份、单独测，是因为 `update.sh` 的回滚分支里裹着 git 操作，
 * 没法在用例里原样跑。把「文件怎么进、怎么出」抽成纯文件系统操作，才测得动。
 * 两个脚本各一份实现，`deploy-release.sh` 与 `update.sh` 共用——不是各抄一份。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..');
const SNAPSHOT = path.join(REPO, 'scripts', 'snapshot-openclaw-config.sh');
const RESTORE = path.join(REPO, 'scripts', 'restore-openclaw-config.sh');

let home: string;
let configPath: string;

const run = (script: string, args: string[] = []) =>
  execFileSync('bash', [script, ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const writeConfig = (value: unknown) => fs.writeFileSync(configPath, JSON.stringify(value));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-snap-'));
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
  configPath = path.join(home, '.openclaw', 'openclaw.json');
});

afterEach(() => {
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test] 清理沙箱失败：', err);
  }
});

describe('快照', () => {
  it('把配置原样复制走，并把快照目录路径打到 stdout', () => {
    writeConfig({ agents: { list: [{ id: 'main' }] } });
    const dest = run(SNAPSHOT);

    expect(dest, '脚本必须把快照路径打出来——调用方要靠它回滚').toContain('clawopt-backups');
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'openclaw.json'), 'utf-8')))
      .toEqual({ agents: { list: [{ id: 'main' }] } });
  });

  it('一并带走同目录下会被改写的其它文件', () => {
    writeConfig({ a: 1 });
    fs.writeFileSync(path.join(home, '.openclaw', 'exec-approvals.json'), '{"defaults":{"ask":"on"}}');
    const dest = run(SNAPSHOT);
    // patch-config.js 每次部署都会改 exec-approvals.json，它和 openclaw.json 一样
    // 需要退路。只备份「名字里有 config 的那个」是上一类事故的形状。
    expect(fs.existsSync(path.join(dest, 'exec-approvals.json'))).toBe(true);
  });

  it('配置不存在时安静退出，不报错——全新安装是合法状态', () => {
    expect(() => run(SNAPSHOT)).not.toThrow();
    expect(fs.existsSync(path.join(home, 'clawopt-backups'))).toBe(false);
  });

  it('快照目录不可被他人读取——它整份都是凭据', () => {
    if (process.getuid && process.getuid() === 0) return; // root 下权限位没有意义
    writeConfig({ models: { anthropic: { apiKey: 'sk-secret' } } });
    const dest = run(SNAPSHOT);
    expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
  });

  it('同一秒内连续两次不互相覆盖', () => {
    writeConfig({ v: 1 });
    const first = run(SNAPSHOT);
    writeConfig({ v: 2 });
    const second = run(SNAPSHOT);
    expect(second).not.toBe(first);
    expect(JSON.parse(fs.readFileSync(path.join(first, 'openclaw.json'), 'utf-8'))).toEqual({ v: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(second, 'openclaw.json'), 'utf-8'))).toEqual({ v: 2 });
  });
});

describe('恢复', () => {
  it('把配置恢复成快照时的样子', () => {
    writeConfig({ agents: { list: [{ id: 'main' }] } });
    const snap = run(SNAPSHOT);

    // 模拟 doctor --fix 把配置迁成了新形状
    writeConfig({ agents: { entries: { main: {} } } });

    run(RESTORE, [snap]);

    expect(readConfig(), '回滚了代码却没回滚配置——1.x 的代码配 2.x 的配置')
      .toEqual({ agents: { list: [{ id: 'main' }] } });
  });

  it('覆盖之前先把「当前这份」也照下来——恢复不该是一次销毁', () => {
    writeConfig({ v: 'original' });
    const snap = run(SNAPSHOT);
    writeConfig({ v: 'half-migrated' });

    run(RESTORE, [snap]);

    // 被覆盖掉的那份必须还找得回来：万一恢复本身才是错的决定，
    // 用户不该因为跑了一次回滚就永久失去迁移到一半的现场。
    const dirs = fs.readdirSync(path.join(home, 'clawopt-backups'));
    const superseded = dirs.filter((d) => d.startsWith('superseded-'));
    expect(superseded, '恢复时直接覆盖了当前配置，没有留下退路').toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(
      path.join(home, 'clawopt-backups', superseded[0], 'openclaw.json'), 'utf-8',
    ))).toEqual({ v: 'half-migrated' });
  });

  it('快照不存在时失败退出，且**不碰**现有配置', () => {
    writeConfig({ v: 'keep-me' });
    expect(() => run(RESTORE, [path.join(home, 'clawopt-backups', 'does-not-exist')])).toThrow();
    expect(readConfig()).toEqual({ v: 'keep-me' });
  });

  it('快照目录存在但里面没有 openclaw.json 时同样拒绝', () => {
    writeConfig({ v: 'keep-me' });
    const empty = path.join(home, 'clawopt-backups', 'pre-update-empty');
    fs.mkdirSync(empty, { recursive: true });
    expect(() => run(RESTORE, [empty])).toThrow();
    expect(readConfig()).toEqual({ v: 'keep-me' });
  });

  it('不传参数时拒绝，而不是去猜该恢复哪一份', () => {
    writeConfig({ v: 'keep-me' });
    expect(() => run(RESTORE, [])).toThrow();
    expect(readConfig()).toEqual({ v: 'keep-me' });
  });
});
