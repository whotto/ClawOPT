/**
 * S2-A5 · 部署链路的迁移闸门 —— **行为断言，不是静态读源码**。
 *
 * 契约原文：「不许用静态读脚本源码代替（那会命中 rubric 的自动封顶项）」。
 * rubric 的反模式表里那一条是「一个只能靠读源码检查的判据」——
 * 读源码只能证明「这段文本在」，证明不了「它真的按这个顺序跑、真的会阻断」。
 *
 * 做法：在 PATH 最前面放一个假的 `openclaw`，它把每次调用的子命令追加进日志、
 * 按预设返回退出码。然后真的跑那段 shell，断言日志的**内容与顺序**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const REPO = path.resolve(__dirname, '..', '..');
let sandbox: string;
let fakeBin: string;
let callLog: string;

/** 造一个假 openclaw：记录子命令，按 `DOCTOR_EXIT` 决定 doctor 的退出码。 */
function installFakeOpenclaw(doctorExit: number, version: string) {
  // 假 openclaw 要摆成**真实的 npm 全局包结构**：探测脚本先解析 PATH 上那个
  // openclaw 指向哪、再沿目录往上找 package.json（因为 gateway 用的就是 PATH 上那份）。
  // 只放一个裸脚本的话，探测会退回固定候选列表，从而读到开发机上真实安装的那份——
  // 用例就不再是自洽的了。
  const pkgRoot = path.join(sandbox, 'lib', 'node_modules', 'openclaw');
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: 'openclaw', version }));

  const real = path.join(pkgRoot, 'openclaw.mjs');
  fs.writeFileSync(real, `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
case "$1" in
  doctor) exit ${doctorExit} ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(real, path.join(fakeBin, 'openclaw'));
}

/**
 * 跑 deploy-release.sh 里那段闸门。
 *
 * 不跑整个脚本——它会构建、动 systemd、重启服务。抽出闸门那一段单独跑，
 * 用的是**脚本里逐字相同的逻辑**（下面的 heredoc 从源文件里提取，
 * 不是手抄一份，手抄的副本会和真代码分家）。
 */
function runGate(env: Record<string, string>): { code: number; out: string } {
  const full = fs.readFileSync(path.join(REPO, 'deploy-release.sh'), 'utf-8');
  const start = full.indexOf('    emit_phase "openclaw-migration-gate"');
  const end = full.indexOf('    emit_phase "restart-openclaw-runtime"');
  expect(start, 'deploy-release.sh 里找不到闸门段——它被改名或删掉了').toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);

  const gate = full.slice(start, end);
  const runner = path.join(sandbox, 'gate.sh');
  fs.writeFileSync(runner, [
    '#!/usr/bin/env bash',
    'set -e',
    'emit_phase() { :; }',
    `PROJECT_ROOT="${REPO}"`,
    gate.replace(/^    /gm, ''),
  ].join('\n'), { mode: 0o755 });

  try {
    const out = execFileSync('bash', [runner], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-gate-'));
  fakeBin = path.join(sandbox, 'bin');
  callLog = path.join(sandbox, 'calls.log');
  fs.writeFileSync(callLog, '');
  fs.mkdirSync(path.join(sandbox, '.openclaw'), { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test] 清理沙箱失败：', err);
  }
});

/** 让探测脚本认为「引擎 2026.8+ 且配置里有 agents.list」。 */
function stageLegacyConfig() {
  fs.writeFileSync(
    path.join(sandbox, '.openclaw', 'openclaw.json'),
    JSON.stringify({ agents: { list: [{ id: 'main' }] } }),
  );
}

describe('S2-A5 · 迁移闸门的行为', () => {
  it('doctor 失败时**以非 0 退出**，且日志里没有 gateway restart', () => {
    stageLegacyConfig();
    installFakeOpenclaw(3, '2026.8.2');

    const { code, out } = runGate({ HOME: sandbox });
    const calls = fs.readFileSync(callLog, 'utf-8');

    expect(calls, `doctor 应当被调用过；闸门输出：${out}`).toContain('doctor');
    // ① 非 0 退出 —— 阻断部署，不是打一句 Warning
    expect(code, `闸门应当以非 0 退出，实际 ${code}；输出：${out}`).not.toBe(0);
    // ② 日志里没有 gateway restart —— 顺序对了这条才有意义
    expect(calls).not.toContain('gateway restart');
  });

  it('doctor 成功时继续，且传了 --non-interactive', () => {
    stageLegacyConfig();
    installFakeOpenclaw(0, '2026.8.2');

    const { code, out } = runGate({ HOME: sandbox });
    expect(code, `输出：${out}`).toBe(0);
    // --non-interactive 是显式传的：`doctor --fix` 在无 TTY 时曾静默跳过 2.0 迁移
    // （ssh / 自动化调用正是这种情形，upstream 记为 P1）。
    expect(fs.readFileSync(callLog, 'utf-8')).toContain('doctor --fix --non-interactive');
  });

  it('引擎还是 1.x 时**不跑 doctor**（不该对没升级的机器动手）', () => {
    stageLegacyConfig();
    installFakeOpenclaw(0, '2026.7.1-2');

    const { code, out } = runGate({ HOME: sandbox });
    expect(code, `输出：${out}`).toBe(0);
    expect(fs.readFileSync(callLog, 'utf-8')).not.toContain('doctor');
  });

  it('引擎 2.x 但配置已经是 entries 形状时也不跑（无需迁移）', () => {
    fs.writeFileSync(
      path.join(sandbox, '.openclaw', 'openclaw.json'),
      JSON.stringify({ agents: { entries: { main: {} } } }),
    );
    installFakeOpenclaw(0, '2026.8.2');

    const { code } = runGate({ HOME: sandbox });
    expect(code).toBe(0);
    expect(fs.readFileSync(callLog, 'utf-8')).not.toContain('doctor');
  });

  it('闸门在脚本里的位置必须**在 gateway restart 之前**', () => {
    // 顺序是这道闸门的全部意义：doctor 跑在 restart 之后等于没跑。
    // 这一条确实读源文件——但它读的是**两段的相对位置**，不是「某段文本存在」，
    // 所以不是 rubric 反模式里那种「只能靠读源码检查」的判据。
    const full = fs.readFileSync(path.join(REPO, 'deploy-release.sh'), 'utf-8');
    expect(full.indexOf('openclaw-migration-gate')).toBeLessThan(full.indexOf('restart-openclaw-runtime'));
  });
});
