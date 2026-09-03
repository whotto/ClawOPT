/**
 * 名册接线的**机械守卫** —— 防的是一次真实事故（2026-09-03，生产机）。
 *
 * ## 那次事故
 *
 * 把 Sprint 2 从功能分支移植到 main 时，`git apply -3` 对
 * `agent-provisioner.ts` 报了「Applied cleanly」、退出码 0，**实际什么都没做**。
 * 于是 v1.2.4 带着**没有接线的名册代码**发布并部署到了生产机。
 *
 * 升级引擎之后立刻复现了那个本该被防住的故障：新建的 Agent 写进 `agents.list`，
 * 而引擎读 `entries`——**它看不见那个 Agent**。
 *
 * ## 为什么 158 个用例全绿
 *
 * 因为**守卫和被守卫的代码一起消失了**。那条断言 entries 行为的端到端用例
 * 住在 `agent-provisioner-config.test.ts` 里，而那是个**被修改的文件**——
 * 补丁没落地，它也就不存在了。测试套件对「一个从未出现过的用例」毫无感知。
 *
 * 新文件的用例反而抓住了同类问题：`deploy-migration-gate.test.ts` 是新增文件，
 * 我显式 checkout 过，所以它在；`deploy-release.sh` 的补丁没落地时，它红了 4 条。
 *
 * ## 因此这道守卫住在一个**独立的新文件**里
 *
 * 它不断言行为，只断言**接线本身存在**——用最粗的方式：源码里不该再有裸的名册操作。
 * 一个粗到不可能被误删的检查，胜过一个精确但会跟着代码一起消失的检查。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src');

/** 允许直接碰 `agents.list` / `agents.entries` 的文件，各有理由。 */
const ALLOWED = new Map([
  ['agents-roster.ts', '门面自己——判据的唯一实现处'],
  ['openclaw-config.ts', '形状校验，是判据不是名册操作；走门面会变成循环依赖'],
]);

function scan(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.ts')) continue;
      if (ALLOWED.has(e.name)) continue;

      fs.readFileSync(full, 'utf-8').split('\n').forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return; // 注释里提到不算
        // 裸的名册读写：`.agents.list` / `.agents.entries` 后面跟着索引、方法或赋值
        if (/\.agents\??\.(list|entries)\s*(\[|\.|=[^=])/.test(line)) {
          hits.push({ file: path.relative(SRC, full), line: i + 1, text: line.trim().slice(0, 90) });
        }
      });
    }
  };
  walk(SRC);
  return hits;
}

describe('名册接线守卫：src/ 里不得有裸的 agents.list / agents.entries 操作', () => {
  it('所有名册读写都走门面', () => {
    const hits = scan();
    expect(
      hits,
      `发现裸的名册操作——它们在 OpenClaw 2026.8 上会静默失效：\n`
      + hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n')
      + `\n允许直接操作的只有：${[...ALLOWED].map(([f, why]) => `${f}（${why}）`).join('、')}`,
    ).toEqual([]);
  });

  it('门面确实被 agent-provisioner 用上了（不是只导入不调用）', () => {
    const src = fs.readFileSync(path.join(SRC, 'agent-provisioner.ts'), 'utf-8');
    // 粗但有效：接线一旦整体消失，这几个计数会同时归零。
    expect(src, 'agent-provisioner 没有解析名册形状').toContain('rosterShapeOf');
    expect((src.match(/rosterShapeOf/g) ?? []).length, '接线点数量明显偏少').toBeGreaterThanOrEqual(8);
    expect(src).toContain('upsertRosterEntry');
    expect(src).toContain('removeRosterEntry');
    expect(src).toContain('listRosterEntries');
  });

  it('index.ts 的群运行时 agent 收集也走门面', () => {
    const src = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf-8');
    expect(src, 'collectGroupRuntimeAgentIds 没走门面').toContain('listRosterEntries');
  });
});
