/**
 * 外接 Agent 厂商凭据的写入与状态。
 *
 * 这一版修的是 v1.3.2 的一个**说假话的界面**：它读 OpenClaw 自己的
 * auth-profiles 来判断 Claude Code 有没有登录，而那是错的库。
 * 所以这里的断言重点不在「能不能写进去」，在**它不再声称自己知道不知道的事**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;

async function load() {
  vi.resetModules();
  return await import('../src/acp-vendor-env');
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-clawopt-venv-'));
  fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const envFile = () => path.join(tmpHome, '.openclaw', '.env');

describe('变量名表', () => {
  it('Pi 没有环境变量，且这是如实标注而非遗漏', async () => {
    const { VENDOR_ENV_KEY } = await load();
    // 引擎的凭据环境变量总表（docs/cli/migrate.md:221）里没有 Pi 的。
    // 编一个 PI_API_KEY 会让界面假装这条路通着——用户填完、显示已配置、
    // 而 Agent 依然回不了话，且没有报错指向原因。
    expect(VENDOR_ENV_KEY.pi).toBeNull();
    expect(VENDOR_ENV_KEY.openclaw).toBeNull();
  });

  it('其余四个用文档里的名字', async () => {
    const { VENDOR_ENV_KEY } = await load();
    expect(VENDOR_ENV_KEY.claude).toBe('ANTHROPIC_API_KEY');
    expect(VENDOR_ENV_KEY.gemini).toBe('GEMINI_API_KEY');
    expect(VENDOR_ENV_KEY.opencode).toBe('OPENCODE_API_KEY');
    expect(VENDOR_ENV_KEY.codex).toBe('OPENAI_API_KEY');
  });

  it('只认白名单里的变量名', async () => {
    const { isManagedEnvName, setVendorEnvKey, VendorEnvWriteError } = await load();
    expect(isManagedEnvName('ANTHROPIC_API_KEY')).toBe(true);
    // 路由把 runtimeId 映射成变量名，但这一层自己也要挡：
    // 允许任意变量名 = 让接口能改 PATH、LD_PRELOAD 这类东西。
    expect(isManagedEnvName('PATH')).toBe(false);
    expect(() => setVendorEnvKey('PATH', '/evil')).toThrow(VendorEnvWriteError);
  });
});

describe('写入', () => {
  it('写完读得到名字，但读不到值', async () => {
    const { setVendorEnvKey, readVendorEnvNames } = await load();
    setVendorEnvKey('ANTHROPIC_API_KEY', 'sk-ant-secret');
    const names = readVendorEnvNames();
    expect(names?.has('ANTHROPIC_API_KEY')).toBe(true);
    // 值不在返回结构里的任何地方。
    expect(JSON.stringify([...(names ?? [])])).not.toContain('sk-ant-secret');
  });

  it('权限收到 600 —— 这个文件全是凭据', async () => {
    const { setVendorEnvKey } = await load();
    setVendorEnvKey('ANTHROPIC_API_KEY', 'sk-ant-1');
    expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600);
  });

  it('不吃掉文件里其他的行', async () => {
    const { setVendorEnvKey } = await load();
    // 这个文件是引擎读的，用户可能自己往里放过东西。
    // 整份重写会静默删掉它们，而且要等到那个东西不工作了才会发现。
    fs.writeFileSync(envFile(), '# 我自己加的\nMY_OWN_VAR=keep-me\n');
    setVendorEnvKey('GEMINI_API_KEY', 'g-1');
    const text = fs.readFileSync(envFile(), 'utf-8');
    expect(text).toContain('MY_OWN_VAR=keep-me');
    expect(text).toContain('# 我自己加的');
    expect(text).toContain('GEMINI_API_KEY=g-1');
  });

  it('重复写同一个 key 不产生两行', async () => {
    const { setVendorEnvKey } = await load();
    setVendorEnvKey('GEMINI_API_KEY', 'old');
    setVendorEnvKey('GEMINI_API_KEY', 'new');
    const lines = fs.readFileSync(envFile(), 'utf-8').split('\n').filter((l) => l.startsWith('GEMINI_API_KEY='));
    // 两行同名时 .env 的取值取决于解析顺序——一个我们不该赌的行为。
    expect(lines).toEqual(['GEMINI_API_KEY=new']);
  });

  it('带换行的值被拒绝 —— 否则会注入出另一个变量', async () => {
    const { setVendorEnvKey, VendorEnvWriteError } = await load();
    // 从网页表单粘贴凭据时带尾随换行是常事；如果只 trim 不校验，
    // 中间带换行的值会在 .env 里凭空造出第二个变量。
    expect(() => setVendorEnvKey('ANTHROPIC_API_KEY', 'sk-1\nPATH=/evil')).toThrow(VendorEnvWriteError);
    expect(fs.existsSync(envFile())).toBe(false);
  });

  it('尾随空白被 trim，不当成非法', async () => {
    const { setVendorEnvKey } = await load();
    setVendorEnvKey('ANTHROPIC_API_KEY', '  sk-ant-2  ');
    expect(fs.readFileSync(envFile(), 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-2');
  });

  it('空值拒绝，而不是写一个空 key', async () => {
    const { setVendorEnvKey, VendorEnvWriteError } = await load();
    // 引擎对空凭据的行为是「像没设一样」，但界面会显示已配置。
    // 又一个「显示的和真的不一致」。
    expect(() => setVendorEnvKey('ANTHROPIC_API_KEY', '   ')).toThrow(VendorEnvWriteError);
  });
});

describe('删除', () => {
  it('删掉后名字消失，其他 key 不受影响', async () => {
    const { setVendorEnvKey, clearVendorEnvKey, readVendorEnvNames } = await load();
    setVendorEnvKey('ANTHROPIC_API_KEY', 'a');
    setVendorEnvKey('GEMINI_API_KEY', 'g');
    expect(clearVendorEnvKey('ANTHROPIC_API_KEY')).toBe(true);
    const names = readVendorEnvNames();
    expect(names?.has('ANTHROPIC_API_KEY')).toBe(false);
    expect(names?.has('GEMINI_API_KEY')).toBe(true);
  });

  it('删一个本来就没有的，返回 false 而不是报错', async () => {
    const { clearVendorEnvKey } = await load();
    expect(clearVendorEnvKey('GEMINI_API_KEY')).toBe(false);
  });
});

describe('状态：不声称自己不知道的事', () => {
  it('没有 missing 这个状态', async () => {
    vi.resetModules();
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'runtime-auth.ts'), 'utf-8');
    // v1.3.2 敢说「未登录」，而它读的是错的库，所以那句话是假的。
    // 我们能确知的只有「我们写的 key 在不在」，说不出「厂商 CLI 没登录」。
    expect(src).not.toContain("'missing'");
  });

  it('没写 key 时是 unknown，不是「未配置」的断言', async () => {
    vi.resetModules();
    const { readRuntimeAuthStatus } = await import('../src/runtime-auth');
    const rows = readRuntimeAuthStatus();
    const claude = rows.find((r) => r.runtimeId === 'claude');
    expect(claude?.state).toBe('unknown');
  });

  it('写了 key 之后变成 configured', async () => {
    vi.resetModules();
    const { setVendorEnvKey } = await import('../src/acp-vendor-env');
    setVendorEnvKey('ANTHROPIC_API_KEY', 'sk-x');
    const { readRuntimeAuthStatus } = await import('../src/runtime-auth');
    expect(readRuntimeAuthStatus().find((r) => r.runtimeId === 'claude')?.state).toBe('configured');
  });

  it('Pi 标成网页配不了，而不是给个填不生效的框', async () => {
    vi.resetModules();
    const { readRuntimeAuthStatus } = await import('../src/runtime-auth');
    const pi = readRuntimeAuthStatus().find((r) => r.runtimeId === 'pi');
    expect(pi?.webConfigurable).toBe(false);
    expect(pi?.envKey).toBeNull();
  });

  it('.env 读不出来时是 unreadable，与「没配」分开', async () => {
    vi.resetModules();
    // 把 .env 做成目录：读得到 stat 但不是普通文件。
    fs.mkdirSync(envFile(), { recursive: true });
    const { readRuntimeAuthStatus } = await import('../src/runtime-auth');
    expect(readRuntimeAuthStatus().find((r) => r.runtimeId === 'claude')?.state).toBe('unreadable');
  });
});
