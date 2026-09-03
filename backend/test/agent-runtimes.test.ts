/**
 * Agent 运行时选择 —— 让 5 个外部 Agent 出现在 ClawOPT 里的那一步。
 *
 * ## 背景：真机实测出来的缺口
 *
 * 2026-09-03 在生产机（OpenClaw 2026.8.2 + acpx）上双向测过：
 *
 * - 直接在 `openclaw.json` 里建一个 `runtime: {type:'acp', acp:{agent:'claude'}}`
 *   的 Agent → **引擎认它**，`openclaw agents list` 列得出来
 * - 但 ClawOPT 的会话列表还是 7 个 —— 它的列表来自自己的 SQLite，不读 openclaw.json
 * - 反过来从 ClawOPT 建一个 Agent → 写进 entries 的是
 *   `{"workspace": "...", "tools": {"profile":"full"}}`，**没有 runtime 字段**
 *
 * 所以差的不是「能不能接」，是「界面上能不能表达」。这批用例钉住那一步。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AGENT_RUNTIMES,
  DEFAULT_AGENT_RUNTIME,
  normalizeAgentRuntime,
  buildRuntimeConfig,
  readAgentRuntimeFromEntry,
} from '../src/agent-runtimes';

let tmpHome: string;
let prevHome: string | undefined;
let configPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-rt-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  configPath = path.join(tmpHome, '.openclaw', 'openclaw.json');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch (err) {
    console.warn('[test] 清理失败：', err);
  }
});

describe('运行时清单', () => {
  it('用户点名的五个都在，外加默认的 openclaw', () => {
    const ids = AGENT_RUNTIMES.map((r) => r.id);
    for (const wanted of ['claude', 'gemini', 'opencode', 'pi', 'codex']) {
      expect(ids, `缺少 ${wanted}`).toContain(wanted);
    }
    expect(ids).toContain('openclaw');
  });

  it('每一项都写明需要什么账号 —— 别让用户建完才发现用不了', () => {
    for (const r of AGENT_RUNTIMES) {
      if (r.id === DEFAULT_AGENT_RUNTIME) continue;
      expect(r.requires, `${r.id} 没写需要什么账号`).toBeTruthy();
    }
  });
});

describe('归一化：认不出来退默认，但要能分辨「没传」和「传错」', () => {
  it('合法值原样返回', () => {
    expect(normalizeAgentRuntime('claude')).toEqual({ id: 'claude', recognized: true });
  });

  it('没传 → 默认，且算「认得」（不该报警告）', () => {
    expect(normalizeAgentRuntime(undefined)).toEqual({ id: DEFAULT_AGENT_RUNTIME, recognized: true });
    expect(normalizeAgentRuntime(null)).toEqual({ id: DEFAULT_AGENT_RUNTIME, recognized: true });
  });

  it('传了个不认识的 → 默认，且**标记为认不出**（调用方要出声）', () => {
    // 两者必须可分辨：静默接受一个未知别名会把它写进 openclaw.json，
    // 而引擎读到未知别名时的行为我们没验过。
    expect(normalizeAgentRuntime('gpt-9')).toEqual({ id: DEFAULT_AGENT_RUNTIME, recognized: false });
    expect(normalizeAgentRuntime(42)).toEqual({ id: DEFAULT_AGENT_RUNTIME, recognized: false });
  });
});

describe('翻译成名册条目的 runtime 字段', () => {
  it('openclaw（默认）**不落盘** —— 显式写默认值是给用户配置加噪声', () => {
    expect(buildRuntimeConfig('openclaw', '/ws')).toBeUndefined();
  });

  it('ACP 系的写成引擎认得的形状', () => {
    expect(buildRuntimeConfig('claude', '/ws/x')).toEqual({
      type: 'acp',
      acp: { agent: 'claude', cwd: '/ws/x' },
    });
  });

  it('读回来能还原（界面回显）', () => {
    for (const id of ['claude', 'gemini', 'opencode', 'pi', 'codex'] as const) {
      const entry = { workspace: '/w', runtime: buildRuntimeConfig(id, '/w') };
      expect(readAgentRuntimeFromEntry(entry)).toBe(id);
    }
  });

  it('没有 runtime 字段 / 形状不对 → 都读成默认，不抛', () => {
    for (const entry of [{}, null, undefined, { runtime: null }, { runtime: {} },
                         { runtime: { type: 'acp' } }, { runtime: { type: 'acp', acp: {} } },
                         { runtime: { type: 'weird', acp: { agent: 'claude' } } }]) {
      expect(readAgentRuntimeFromEntry(entry)).toBe(DEFAULT_AGENT_RUNTIME);
    }
  });
});

describe('端到端：provision 把运行时写进名册，读回来一致', () => {
  it('选 claude → entries 里出现 runtime.acp.agent=claude，且 cwd 是工作区', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: {} } }));
    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();

    await p.provision({ agentId: 'claude-agent', agentRuntime: 'claude' });

    const disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const entry = disk.agents.entries['claude-agent'];
    expect(entry.runtime).toEqual({
      type: 'acp',
      acp: { agent: 'claude', cwd: entry.workspace },
    });
    // 回显链路
    expect(p.readAgentRuntimeConfig('claude-agent').agentRuntime).toBe('claude');
  });

  it('不选（默认）→ 名册里**没有** runtime 键', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: {} } }));
    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();

    await p.provision({ agentId: 'plain-agent' });

    const entry = JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents.entries['plain-agent'];
    expect('runtime' in entry).toBe(false);
    expect(p.readAgentRuntimeConfig('plain-agent').agentRuntime).toBe(DEFAULT_AGENT_RUNTIME);
  });

  it('从 claude 改回默认 → runtime 键被删掉，不是留一个空壳', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: {} } }));
    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();

    await p.provision({ agentId: 'switcher', agentRuntime: 'gemini' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents.entries.switcher.runtime).toBeTruthy();

    await p.provision({ agentId: 'switcher', agentRuntime: 'openclaw' });
    const entry = JSON.parse(fs.readFileSync(configPath, 'utf-8')).agents.entries.switcher;
    expect('runtime' in entry).toBe(false);
  });

  it('list 形状（1.x 引擎）下同样写得进去', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { list: [] } }));
    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();

    await p.provision({ agentId: 'legacy-shape', agentRuntime: 'pi' });

    const disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const entry = disk.agents.list.find((e: any) => e.id === 'legacy-shape');
    expect(entry.runtime.acp.agent).toBe('pi');
    expect('entries' in disk.agents).toBe(false);
  });
});

/**
 * 回显必须真的到达前端 —— 真机验收暴露的缺口。
 *
 * 2026-09-03 在生产机上验收 v1.3.0 时发现：名册写对了、引擎认了、会话列表里也有了，
 * 但 `GET /api/sessions/:id/configs` 返回的 `agentRuntime` 是 **undefined**。
 *
 * 原因是那两处响应在**逐字段拷贝** `runtimeSettings`，而不是展开——
 * 我在 `readEffectiveAgentRuntimeSettings()` 里加了新字段，拷贝那侧没跟着加。
 *
 * 后果不是报错：下拉框会一直显示「OpenClaw（默认）」，**哪怕这个 Agent
 * 明明跑在 Claude Code 上**。用户改一次别的设置保存，就把运行时改回默认了。
 * 逐字段拷贝的代价就是这个——加字段时它不会提醒你。
 */
describe('运行时回显：新增字段必须出现在 configs 响应里', () => {
  it('readEffectiveAgentRuntimeSettings 的每个字段都在 configs 的组装里被引用', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'index.ts'), 'utf-8');

    // 从函数的返回类型里取出字段名，再逐个检查响应组装处有没有引用。
    const fn = src.slice(src.indexOf('function readEffectiveAgentRuntimeSettings'));
    const sig = fn.slice(0, fn.indexOf('} {'));
    const fields = [...sig.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(fields.length, '解析不出字段名，用例本身失效了').toBeGreaterThanOrEqual(4);

    for (const field of fields) {
      const uses = (src.match(new RegExp(`runtimeSettings(?:Value)?\\.${field}\\b`, 'g')) ?? []).length;
      expect(uses, `configs 响应没有带上 ${field} —— 逐字段拷贝漏了它`).toBeGreaterThanOrEqual(2);
    }
  });
});
