/**
 * 在 `agents.entries` 形状下读得出每个 Agent 的独立模型。
 *
 * ## 这条守卫买来的教训
 *
 * `readAgentModelConfig` 里原来是：
 *
 * ```ts
 * const entry = Array.isArray(config.agents?.list)   // ← 只认旧形状
 *   ? this.rosterEntryRef(config, this.rosterShapeOf(config), agentId)
 *   : null;
 * ```
 *
 * 2026.8 起名册是 `agents.entries`，`config.agents.list` 恒为 undefined，
 * 于是三元式**直接取 null**，每个 Agent 的独立模型都读不出来，一律退回全局默认。
 *
 * 生产实测（2026-09-03）：一个 `model: claude-cli/claude-sonnet-5` 的 Agent
 * 被拉进团队，克隆体拿不到模型，回话的是 **DeepSeek**，而界面上名字还挂着
 * 「Claude Code」：
 *
 * ```
 * 发言人:      Claude Code
 * model_used:  deepseek/deepseek-v4-flash
 * 内容:        DeepSeek V4 Flash（deepseek/deepseek-v4-flash，厂商 DeepSeek）
 * ```
 *
 * 单聊时看不出来，因为那条路是**引擎自己**读 openclaw.json；只有 ClawOPT 需要
 * 把模型**复制**给团队克隆体时才暴露。
 *
 * 讽刺的是同一份文件 1436 行早就写着这个坑（「2.x 上 config.agents.list 是
 * undefined，旧写法会静默不做任何清理」）——**知道了却只堵了那一处**。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let prevHome: string | undefined;
let configPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-entries-model-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.openclaw'), { recursive: true });
  configPath = path.join(tmpHome, '.openclaw', 'openclaw.json');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const writeConfig = (agents: Record<string, unknown>) =>
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-flash' } }, ...agents },
  }, null, 2));

async function provisioner() {
  const { AgentProvisioner } = await import('../src/agent-provisioner');
  return new AgentProvisioner() as any;
}

describe('entries 形状（2026.8+）', () => {
  it('读得出 Agent 自己的模型，而不是退回全局默认', async () => {
    writeConfig({
      entries: {
        'cc-agent': { workspace: '/tmp/ws', model: 'claude-cli/claude-sonnet-5' },
      },
    });
    const p = await provisioner();
    const snap = p.readAgentModelConfig('cc-agent');

    // modelOverride 是团队克隆时**复制过去的那个值**。它为 null 就等于
    // 克隆体没有模型，落到全局默认——外接 Agent 静默变成 DeepSeek。
    expect(snap.modelOverride, '独立模型没读出来（entries 形状被当成没有名册）')
      .toBe('claude-cli/claude-sonnet-5');
    expect(snap.resolvedModel).toBe('claude-cli/claude-sonnet-5');
  });

  it('没配独立模型的 Agent 才退回全局默认', async () => {
    writeConfig({ entries: { plain: { workspace: '/tmp/ws' } } });
    const p = await provisioner();
    expect(p.readAgentModelConfig('plain').resolvedModel).toBe('deepseek/deepseek-v4-flash');
  });

  it('main 也一样 —— 它走的是另一条分支，同样踩过这个坑', async () => {
    writeConfig({ entries: { main: { workspace: '/tmp/ws', model: 'claude-cli/claude-opus-5' } } });
    const p = await provisioner();
    expect(p.readAgentModelConfig('main').resolvedModel).toBe('claude-cli/claude-opus-5');
  });
});

describe('list 形状（2026.7）不能被这次修复弄坏', () => {
  it('旧形状仍然读得出', async () => {
    writeConfig({ list: [{ id: 'old-agent', workspace: '/tmp/ws', model: 'anthropic/claude-opus-5' }] });
    const p = await provisioner();
    expect(p.readAgentModelConfig('old-agent').modelOverride).toBe('anthropic/claude-opus-5');
  });

  it('list 形状下的 main', async () => {
    writeConfig({ list: [{ id: 'main', workspace: '/tmp/ws', model: 'openai/gpt-5.6' }] });
    const p = await provisioner();
    expect(p.readAgentModelConfig('main').resolvedModel).toBe('openai/gpt-5.6');
  });
});

describe('不许再用旧形状当开关', () => {
  it('源码里不得出现 `Array.isArray(config.agents.list)` 这类形状分支', () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'agent-provisioner.ts'), 'utf-8',
    );
    // **先剥注释再扫。** 不剥的话，解释这个坑的注释本身会把守卫染红——
    // 一条会误报的守卫，下一个人会直接把它删掉，那就等于没有守卫。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');

    // 形状判断只该有一处实现（agents-roster 的 resolveRosterShape）。
    // 在调用点重新判一次，就是这次事故的形状：门面接进来了，
    // 开关还留着旧的，于是门面根本没被调用到。
    const offenders = [...code.matchAll(/Array\.isArray\(\s*config\??\.?agents\??\.?list\s*\)/g)];
    expect(offenders.map((m) => m[0]), '又在调用点判断名册形状了').toEqual([]);
  });
});
