/**
 * 可服务路径闸门。
 *
 * 这个模块的存在源于三次真实泄露：/api/config 明文吐口令、
 * /api/files/download 读任意文件、/openclaw 静态挂载整棵目录树。
 * 后来又发现 preview 三个入口漏在闸门之外——同一类洞修一个不修其余等于没修。
 * 下面的用例就是那些洞的固化。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// realpath 一次：macOS 上 /tmp 与 /var 本身就是软链，不归一化的话
// 「路径是否落在允许根内」的判定会因为环境差异失败，掩盖真正要测的东西。
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'servedtest-')));
process.env.HOME = home;
process.env.CLAWOPT_DATA_DIR = '.clawopt_test';

const workspace = path.join(home, '.openclaw', 'workspace-main');
const uploads = path.join(home, '.clawopt_test', 'uploads');
const outside = path.join(home, 'secret');

beforeAll(() => {
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# soul');
  fs.writeFileSync(path.join(workspace, 'auth-profiles.json'), '{"token":"secret"}');
  fs.writeFileSync(path.join(workspace, 'id_rsa'), 'PRIVATE');
  fs.writeFileSync(path.join(uploads, 'photo.png'), 'png');
  fs.writeFileSync(path.join(home, '.openclaw', 'openclaw.json'), '{"models":{"providers":{"a":{"apiKey":"sk-x"}}}}');
  fs.writeFileSync(path.join(outside, 'private.key'), 'KEY');
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

// 模块在导入时读 HOME，所以必须在设置环境变量之后再 import
const { resolveServablePath } = await import('../src/served-paths');

describe('放行', () => {
  it('工作区里的普通文件', () => {
    const verdict = resolveServablePath(path.join(workspace, 'SOUL.md'));
    expect(verdict.ok).toBe(true);
  });

  it('上传目录里的文件', () => {
    expect(resolveServablePath(path.join(uploads, 'photo.png')).ok).toBe(true);
  });
});

describe('拒绝', () => {
  it('工作区之外的任意文件', () => {
    const verdict = resolveServablePath(path.join(outside, 'private.key'));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('outsideAllowedRoots');
  });

  it('~/.openclaw 根目录下的 openclaw.json（含模型 apiKey）', () => {
    expect(resolveServablePath(path.join(home, '.openclaw', 'openclaw.json')).ok).toBe(false);
  });

  it('工作区内的凭据与密钥类文件', () => {
    expect(resolveServablePath(path.join(workspace, 'auth-profiles.json')).ok).toBe(false);
    expect(resolveServablePath(path.join(workspace, 'id_rsa')).ok).toBe(false);
  });

  it('相对路径', () => {
    const verdict = resolveServablePath('etc/passwd');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('notAbsolute');
  });

  it('不存在的文件与目录本身', () => {
    expect(resolveServablePath(path.join(workspace, 'nope.md')).ok).toBe(false);
    expect(resolveServablePath(workspace).ok).toBe(false);
  });

  it('符号链接逃逸：工作区里指向外部私钥的软链', () => {
    const link = path.join(workspace, 'photo.png');
    fs.symlinkSync(path.join(outside, 'private.key'), link);
    const verdict = resolveServablePath(link);
    expect(verdict.ok).toBe(false);       // 名字像图片，真身在工作区外
    fs.unlinkSync(link);
  });

  it('用 .. 拼出来的越界路径', () => {
    expect(resolveServablePath(path.join(workspace, '..', '..', 'secret', 'private.key')).ok).toBe(false);
  });
});
