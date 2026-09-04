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
