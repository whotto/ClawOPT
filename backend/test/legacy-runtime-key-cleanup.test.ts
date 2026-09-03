/**
 * 清掉 `agents.entries.*.runtime` —— v1.3.0 那个会骗人的键。
 *
 * ## 它为什么是错的
 *
 * v1.3.0–v1.4.0 的「运行时」下拉框往名册条目里写
 * `{ type: 'acp', acp: { agent: 'claude' } }`。引擎从来不读它：
 *
 * > whole-agent runtime keys are **legacy and ignored**.
 * > —— docs/concepts/agent-runtimes.md
 *
 * 2026-09-03 生产实测：建一个 `runtime.acp.agent = "claude"` 的 Agent，
 * 问它「你是哪个模型」，回答 **`DeepSeek-V4-Flash，DeepSeek`**。
 * 选了 Claude Code，拿到的是默认模型，**没有任何报错**。
 *
 * ## 为什么删代码不够
 *
 * 停止写入只能保证「以后不再造」。已经写进用户 `openclaw.json` 的那些废键
 * 会原地留着，而它们正是「界面显示得像配好了」的来源。
 * 所以每次 provision 都删一次，让升级本身把上一版的痕迹清干净。
 *
 * 外接 Agent 的正确接法是模型 ref（`claude-cli/claude-sonnet-5`），走 `model` 字段。
 * 那条路生产上验到了最后一格：请求真的进了 `claude` 子进程，
 * 返回它自己的 `Not logged in · Please run /login`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpHome: string;
let prevHome: string | undefined;
let configPath: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-legacy-rt-'));
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

const readEntry = (id: string) =>
  JSON.parse(fs.readFileSync(configPath, 'utf-8'))?.agents?.entries?.[id];

describe('遗留 runtime 键', () => {
  it('provision 会删掉上一版留下的 runtime 键', async () => {
    // v1.3.0 留下的现场：一个用户以为选了 Claude Code 的 Agent。
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        entries: {
          'legacy-agent': {
            workspace: '/tmp/ws',
            tools: { profile: 'full' },
            runtime: { type: 'acp', acp: { agent: 'claude', cwd: '/tmp/ws' } },
          },
        },
      },
    }, null, 2));

    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();
    await p.provision({ agentId: 'legacy-agent' });

    const entry = readEntry('legacy-agent');
    expect(entry, 'Agent 不该被删掉').toBeTruthy();
    expect(entry.runtime, '遗留的 runtime 键没被清掉').toBeUndefined();
    // 只清这一个键，别的不能动 —— 清理不该顺手拆掉用户的其他配置。
    expect(entry.tools).toEqual({ profile: 'full' });
  });

  it('新建的 Agent 不会带 runtime 键', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: {} } }, null, 2));
    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();
    await p.provision({ agentId: 'fresh-agent' });
    expect(readEntry('fresh-agent')?.runtime).toBeUndefined();
  });

  it('外接 Agent 走 model 字段，不走 runtime', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: {} } }, null, 2));
    const { AgentProvisioner } = await import('../src/agent-provisioner');
    const p: any = new AgentProvisioner();
    // 这是生产上验过的形状：模型 ref 指向 CLI 后端。
    await p.provision({ agentId: 'cc-agent', model: 'claude-cli/claude-sonnet-5' });

    const entry = readEntry('cc-agent');
    expect(entry.model).toBe('claude-cli/claude-sonnet-5');
    expect(entry.runtime).toBeUndefined();
  });
});

describe('源码里不该再有那个写入点', () => {
  it('provisioner 不再往 entry.runtime 赋值', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'agent-provisioner.ts'), 'utf-8',
    );
    // 只允许 delete，不允许赋值。有人日后「把功能加回来」时这条会红，
    // 逼他先去读上面那段为什么。
    expect(src).not.toMatch(/entry\.runtime\s*=/);
    expect(src).toContain('delete entry.runtime;');
  });
});
