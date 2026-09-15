/**
 * 成长轨迹（P6）：
 * 1. MEMORY.md 的日期小节解析（多种日期写法、代码块里的标题不算、非法日期不算）；
 * 2. 技能节点：「Agent 自己写的」只按写入审批历史判，待审标 pending，其余来源未知；逃出工作区的软链技能不读；
 * 3. 记忆卡片版本链连边、删除的卡片不出现；小节提到技能名连边；时间排序；
 * 4. 路由按 Agent 授权读（member 读别人的 403）。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/bootstrap';
import { createAuthMiddleware } from '../src/core/auth';
import { createJourneyService, parseDatedMemorySections, parseSkillFrontmatter } from '../src/control';
import { createStubContext } from './helpers/stub-context';
import http from 'http';
import type { AddressInfo } from 'net';

describe('MEMORY.md 日期小节', () => {
  it('认多种日期写法，代码块里的标题与非法日期不算，小节到同级标题为止', () => {
    const sections = parseDatedMemorySections([
      '# 记忆',
      '## 2026-09-14 学会写周报',
      '用 weekly-report 技能整理。',
      '### 细节',
      '子标题属于上一节',
      '## 2026/09/15',
      '第二天',
      '```md',
      '## 2026-01-01 代码块里的不算',
      '```',
      '## 2026年9月16日 中文日期',
      '## 2026-02-30 非法日期',
      '不属于任何小节',
      '## 普通标题',
    ].join('\n'));
    expect(sections.map((section) => [section.date.slice(0, 10), section.title])).toEqual([
      ['2026-09-14', '2026-09-14 学会写周报'],
      ['2026-09-15', '2026/09/15'],
      ['2026-09-16', '2026年9月16日 中文日期'],
    ]);
    expect(sections[0].body).toContain('子标题属于上一节');
    expect(sections[1].body).toContain('代码块里的不算');
  });

  it('SKILL.md frontmatter', () => {
    expect(parseSkillFrontmatter('---\nname: weekly-report\ndescription: "写周报"\ncategory: writing\n---\n# x')).toEqual({ name: 'weekly-report', description: '写周报', category: 'writing' });
    expect(parseSkillFrontmatter('# no frontmatter')).toEqual({ name: null, description: null, category: null });
  });
});

describe('轨迹图', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-journey-'));
    workspace = path.join(root, 'workspace-main');
    outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(workspace, 'skills', 'weekly-report'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'skills', 'drafting'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'skills', 'manual'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(outside, 'evil'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '## 2026-09-01 开始\n认识用户\n## 2026-09-10 周报\n学会了 weekly-report\n');
    fs.writeFileSync(path.join(workspace, 'memory', '2026-09-05.md'), '# 周五\n整理资料');
    fs.writeFileSync(path.join(workspace, 'skills', 'weekly-report', 'SKILL.md'), '---\nname: weekly-report\ncategory: writing\n---\n');
    fs.writeFileSync(path.join(workspace, 'skills', 'drafting', 'SKILL.md'), '---\nname: drafting\n---\n');
    fs.writeFileSync(path.join(workspace, 'skills', 'manual', 'SKILL.md'), '# manual');
    fs.writeFileSync(path.join(outside, 'evil', 'SKILL.md'), '---\nname: evil\n---\n');
    fs.symlinkSync(path.join(outside, 'evil'), path.join(workspace, 'skills', 'escape'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const service = () => createJourneyService({
    engineRoster: { get: async () => ({ id: 'main', workspace, agentDir: null, isDefault: true, bindings: 0 }) },
    agentProvisioner: { getWorkspacePath: () => workspace },
    writeGate: {
      listHistory: () => [
        { relPath: 'skills/weekly-report/SKILL.md', decision: 'approved', action: 'create' },
        { relPath: 'skills/manual/SKILL.md', decision: 'rejected', action: 'create' },
      ],
      listPending: () => ({ records: [{ relPath: 'skills/drafting/SKILL.md', action: 'update' }] }),
    },
    memory: {
      listAllForProfile: () => [
        { id: 'c1', title: '称呼', content: '叫我老王', kind: 'profile_name', categoryPath: 'profile/name', status: 'superseded', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', supersedesId: null },
        { id: 'c2', title: '称呼', content: '叫我王总', kind: 'profile_name', categoryPath: 'profile/name', status: 'active', createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z', supersedesId: 'c1' },
        { id: 'c3', title: '已删', content: 'x', kind: 'custom_fact', categoryPath: 'fact', status: 'deleted', createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z', supersedesId: null },
      ],
    },
  });

  it('节点齐全、按时间排序；技能来源只按审批历史判；软链逃逸的技能不读；版本链与提及连边', async () => {
    const graph = await service().graph('main');
    expect(graph.workspaceAvailable).toBe(true);
    const skills = Object.fromEntries(graph.nodes.filter((node) => node.kind === 'skill').map((node) => [node.label, node.createdBy]));
    expect(skills).toEqual({ 'weekly-report': 'agent', drafting: 'pending', manual: 'unknown' });
    expect(graph.nodes.some((node) => node.label === 'evil')).toBe(false);
    expect(graph.nodes.some((node) => node.id === 'card:c3')).toBe(false);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'card:c1', target: 'card:c2', kind: 'revision' }),
      expect.objectContaining({ target: 'skill:weekly-report', kind: 'mentions' }),
    ]));
    const timeline = graph.nodes.filter((node) => node.kind === 'memory' || node.kind === 'daily').map((node) => node.timestamp.slice(0, 10));
    expect(timeline).toEqual(['2026-09-01', '2026-09-05', '2026-09-10']);
    expect(graph.stats).toMatchObject({ memory: 2, daily: 1, skills: 3, agentSkills: 1, cards: 2 });
  });

  it('外部运行时（ext:）没有工作区：只有记忆卡片，不读任何目录', async () => {
    const graph = await service().graph('ext:claude-code');
    expect(graph.workspaceAvailable).toBe(false);
    expect(graph.nodes.every((node) => node.kind === 'card')).toBe(true);
  });
});

describe('路由按 Agent 授权', () => {
  it('member 读别人的 Agent 403', async () => {
    const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
    const authStore = { resolve: (token: string) => (token === 'm' ? { token, userId: 2 } : null) };
    const userStore = { count: () => 1, get: () => ({ id: 2, username: 'm', role: 'member', status: 'active', mustChangePassword: false }), firstActiveSuperAdmin: () => null, hasAgent: (_: number, agentId: string) => agentId === 'mine' };
    const auth = createAuthMiddleware({ configManager, authStore, userStore } as never);
    const built = buildApp(createStubContext({ configManager, authStore, userStore, auth }));
    const server = http.createServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${url}/api/agents/other/journey`, { headers: { 'X-ClawOPT-Auth-Token': 'm' } })).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
