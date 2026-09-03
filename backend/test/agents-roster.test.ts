/**
 * agents 名册门面 —— S2-A2 / S2-A3 / S2-A2-f。
 *
 * 六种配置形状每一种都要单独断言（S2-A3 原文：「断言六种形状各自的结果，
 * 不是跑六遍同一个断言」）。其中**只有「只有 list」是真实用户状态**——
 * 2026-09-03 实测生产机上 7 个 Agent 全在 list 里、`entries` 不存在。
 * 其余五种是防御性覆盖。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRosterShape,
  listRosterEntries,
  findRosterEntry,
  upsertRosterEntry,
  removeRosterEntry,
  describeRosterWarnings,
} from '../src/agents-roster';
import { parseOpenClawVersion, unknownVersion } from '../src/openclaw-version';

const V17 = parseOpenClawVersion('2026.7.1-2'); // 生产机现状
const V18 = parseOpenClawVersion('2026.8.2');   // 上游最新
const VUNK = unknownVersion('notInstalled');

/** 生产机上那 7 个 Agent 的真实 id（2026-09-03 实测）。 */
const PROD_AGENTS = ['biz-insight', 'ceo-assistant', 'course-design', 'intel-research', 'main', 'org-diagnosis', 'sci-decision'];
const prodConfig = () => ({
  agents: { list: PROD_AGENTS.map((id) => ({ id, workspace: `/root/.openclaw/workspace-${id}` })) },
  models: { anthropic: { apiKey: 'sk-keep-me' } },
});

describe('六种配置形状各自的落点（S2-A3）', () => {
  it('① 空配置 + 1.x → list', () => {
    expect(resolveRosterShape({}, V17).shape).toBe('list');
  });

  it('① 空配置 + 2.x → entries', () => {
    expect(resolveRosterShape({}, V18).shape).toBe('entries');
  });

  it('① 空配置 + 版本 unknown → **list**（朝代价小的方向失败）并出声', () => {
    const view = resolveRosterShape({}, VUNK);
    expect(view.shape).toBe('list');
    expect(view.warnings.map((w) => w.code)).toEqual(['versionUnknownDefaultingToList']);
  });

  it('② 只有 list → list，**即使引擎是 2.x**（跟随现状，不擅自迁移）', () => {
    expect(resolveRosterShape(prodConfig(), V18).shape).toBe('list');
    expect(resolveRosterShape(prodConfig(), V17).shape).toBe('list');
  });

  it('③ 只有 entries → entries，**即使引擎是 1.x**（同上，反方向）', () => {
    const cfg = { agents: { entries: { main: { workspace: '/w' } } } };
    expect(resolveRosterShape(cfg, V17).shape).toBe('entries');
  });

  it('④ 两者都有 → entries **且出声**（只落 entries 而不出声 = 不通过）', () => {
    const cfg = { agents: { list: [{ id: 'a' }], entries: { b: {} } } };
    const view = resolveRosterShape(cfg, V17);
    expect(view.shape).toBe('entries');
    expect(view.warnings).toEqual([{ code: 'bothShapesPresent', listCount: 1, entryCount: 1 }]);
    expect(describeRosterWarnings(view.warnings)).toContain('迁移到一半');
  });

  it('⑤ list 为空数组 → 仍算 list（键存在就是现状，不看它有几条）', () => {
    expect(resolveRosterShape({ agents: { list: [] } }, V18).shape).toBe('list');
  });

  it('⑥ entries 为空对象 → 仍算 entries', () => {
    expect(resolveRosterShape({ agents: { entries: {} } }, V17).shape).toBe('entries');
  });
});

describe('S2-A2-f · 贴着生产机现状：7 个 Agent 在 list 里，新建一个', () => {
  it('原有 7 条逐字未变、新条目追加、且配置里仍然没有 entries 键', () => {
    const cfg = prodConfig();
    const before = JSON.stringify(cfg.agents.list);
    const shape = resolveRosterShape(cfg, V17).shape;

    const changed = upsertRosterEntry(cfg as any, shape, { id: 'newcomer', workspace: '/root/.openclaw/workspace-newcomer' });

    expect(changed).toBe(true);
    // ① 原有 7 条**逐字未变**——不是「还在」，是内容一个字节没动
    expect(JSON.stringify((cfg.agents.list as any[]).slice(0, 7))).toBe(before);
    // ② 新条目追加在 list 里
    expect((cfg.agents.list as any[])[7]).toEqual({ id: 'newcomer', workspace: '/root/.openclaw/workspace-newcomer' });
    // ③ 仍然没有 entries **键**（不是「entries 为空」，是键不存在）
    expect('entries' in (cfg.agents as object)).toBe(false);
    // ④ 配置的其余部分没被碰（apiKey 还在）
    expect((cfg as any).models.anthropic.apiKey).toBe('sk-keep-me');
  });

  it('删掉最后一个 Agent 时把 list 键一并删掉，不留空数组', () => {
    const cfg: any = { agents: { list: [{ id: 'only' }] } };
    expect(removeRosterEntry(cfg, 'list', 'only')).toBe(true);
    expect('list' in cfg.agents).toBe(false);
  });
});

describe('读与写在两种形状下语义一致', () => {
  for (const [label, cfg, shape] of [
    ['list', { agents: { list: [{ id: 'a', workspace: '/a' }, { id: 'b', workspace: '/b' }] } }, 'list'],
    ['entries', { agents: { entries: { a: { workspace: '/a' }, b: { workspace: '/b' } } } }, 'entries'],
  ] as const) {
    it(`${label}：列出、按 id 找、更新、删除的结果相同`, () => {
      const c: any = JSON.parse(JSON.stringify(cfg));
      expect(listRosterEntries(c, shape).map((e) => e.id).sort()).toEqual(['a', 'b']);
      expect(findRosterEntry(c, shape, 'a')).toMatchObject({ id: 'a', workspace: '/a' });
      expect(findRosterEntry(c, shape, 'zzz')).toBeNull();

      expect(upsertRosterEntry(c, shape, { id: 'a', workspace: '/changed' })).toBe(true);
      expect(findRosterEntry(c, shape, 'a')).toMatchObject({ workspace: '/changed' });

      // 内容没变时返回 false —— 多写一次配置会触发 gateway 重载，不是免费的
      expect(upsertRosterEntry(c, shape, { id: 'a', workspace: '/changed' })).toBe(false);

      expect(removeRosterEntry(c, shape, 'a')).toBe(true);
      expect(removeRosterEntry(c, shape, 'a')).toBe(false);
      expect(listRosterEntries(c, shape).map((e) => e.id)).toEqual(['b']);
    });
  }

  it('entries 形状里 id 只作为键存在，**不重复存进值里**（两个真值源迟早分叉）', () => {
    const c: any = { agents: { entries: {} } };
    upsertRosterEntry(c, 'entries', { id: 'x', workspace: '/x' });
    expect(c.agents.entries.x).toEqual({ workspace: '/x' });
    expect('id' in c.agents.entries.x).toBe(false);
    // 但读出来时 id 要补回去，调用方不该关心存储形状
    expect(findRosterEntry(c, 'entries', 'x')).toEqual({ id: 'x', workspace: '/x' });
  });
});
