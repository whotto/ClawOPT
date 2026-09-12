/**
 * deploy-release.sh 每次部署都跑 backend/patch-config.js。
 * 它原先往 gateway.controlUi 写 dangerouslyDisableDeviceAuth / allowInsecureAuth，
 * 2026.8 把前者标 retired、后者判 Unrecognized key，网关重启直接报 config invalid。
 * 生产实测（2026-09-04 升 v1.5.2）：restart 失败，靠后续 reinstall 流程才救回。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let configPath: string;
const script = path.resolve(__dirname, '..', 'patch-config.js');

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-patch-config-'));
  fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  configPath = path.join(tmpHome, '.openclaw', 'openclaw.json');
});
afterEach(() => { fs.rmSync(tmpHome, { recursive: true, force: true }); });

const run = () => execFileSync(process.execPath, [script], { env: { ...process.env, HOME: tmpHome }, encoding: 'utf-8' });
const read = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));

describe('patch-config.js 与 2026.8 的 controlUi 校验', () => {
  it('不再往干净的配置里写废弃键', () => {
    fs.writeFileSync(configPath, JSON.stringify({ gateway: { port: 18789 }, commands: { bash: true } }));
    run();
    expect(read().gateway.controlUi).toBeUndefined();
  });

  it('把上一版写进去的废弃键删掉，别的 controlUi 键保留', () => {
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { controlUi: { dangerouslyDisableDeviceAuth: true, allowInsecureAuth: true, enabled: true } },
      commands: { bash: true },
    }));
    run();
    expect(read().gateway.controlUi).toEqual({ enabled: true });
  });
});

/**
 * exec 审批只能有**一个**写入者 —— v1.7.0。
 *
 * ## 现场原来是两个写入者，意图相反
 *
 * `patch-config.js` 每次部署**无条件**写 `ask='off'` / `security='full'` /
 * `agents['*'].allowlist=[{pattern:'*'}]`；而后端在 `setImmediate` 里按
 * 「最高权限」开关收敛——开关关着时把这三个键 `delete` 掉。
 *
 * 两个写入者在同一个文件上朝相反方向写，而 `deploy-release.sh` 的顺序是：
 *
 * ```
 * patch-config（写成全开）
 *   → restart-openclaw-runtime（**网关带着全开的审批重启**）
 *     → service-restart（后端启动，按开关收敛回去）
 * ```
 *
 * 所以文件最终看起来是安全的，但**网关是在全开的那一刻被重启的**。
 * 文件与运行中的状态是否一致，取决于引擎缓不缓存这份审批——这一点我们管不着，
 * 也不该去赌。
 *
 * 还有一条更直白的：后端若启动失败（依赖装坏、端口占用），收敛那一步根本不会跑，
 * 全开状态就留在那里了。
 *
 * ## 结论
 *
 * 部署脚本不再碰 exec 审批。**判据只实现一次**，就在后端那条跟随开关的路径上。
 * 这跟 `openclaw-config.ts` 收口配置读写、`snapshot-openclaw-config.sh` 一份实现
 * 两处调用是同一条原则。
 */
describe('patch-config.js 不得触碰 exec 审批（判据只在后端一处）', () => {
  const approvalsPath = () => path.join(tmpHome, '.openclaw', 'exec-approvals.json');

  it('用户自己收紧过的审批不被放宽', () => {
    fs.writeFileSync(configPath, JSON.stringify({ commands: { bash: true } }));
    const mine = { defaults: { ask: 'on', security: 'standard' }, agents: { main: { allowlist: [] } } };
    fs.writeFileSync(approvalsPath(), JSON.stringify(mine));

    run();

    expect(JSON.parse(fs.readFileSync(approvalsPath(), 'utf-8')), '部署脚本又把审批放开了')
      .toEqual(mine);
  });

  it('不往里塞通配 allowlist', () => {
    fs.writeFileSync(configPath, JSON.stringify({ commands: { bash: true } }));
    fs.writeFileSync(approvalsPath(), JSON.stringify({ defaults: {} }));

    run();

    const after = JSON.parse(fs.readFileSync(approvalsPath(), 'utf-8'));
    expect(after.agents, "通配 allowlist 等于对所有命令免审批").toBeUndefined();
    expect(after.defaults.ask).toBeUndefined();
    expect(after.defaults.security).toBeUndefined();
  });

  it('文件逐字节不变——连格式化都不该动', () => {
    fs.writeFileSync(configPath, JSON.stringify({ commands: { bash: true } }));
    const raw = '{\n  "defaults": { "ask": "on" }\n}\n';
    fs.writeFileSync(approvalsPath(), raw);

    run();

    expect(fs.readFileSync(approvalsPath(), 'utf-8')).toBe(raw);
  });

  it('审批文件不存在时也不去创建它', () => {
    fs.writeFileSync(configPath, JSON.stringify({ commands: { bash: true } }));
    run();
    expect(fs.existsSync(approvalsPath())).toBe(false);
  });
});
