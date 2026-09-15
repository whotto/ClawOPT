/**
 * 成长轨迹（P6，spec 05 F39 的 ClawOPT 版）：一个 Agent 随时间「记住了什么、学会了什么」。
 *
 * 参考实现调引擎的 `journey --json`；OpenClaw 没有这条命令，这里**自己从事实算**：
 * - 记忆：工作区 `MEMORY.md` 里带日期标题的小节（`## 2026-09-14 …`、`### 2026/09/14`、`## 2026年9月14日`），
 *   以及 `memory/` 下按日期命名的每日记录；
 * - 技能：工作区 `skills/<名字>/SKILL.md`（frontmatter 的 name / description / category），创建与最后修改时间取文件时间；
 *   「Agent 自己写的」判据是写入审批的历史（该技能路径下有过批准落地的暂存记录），待审中的标成 pending，其余 unknown——
 *   分不清人手改与 Agent 改的，界面如实写「来源未知」，不猜；
 * - 记忆卡片：记忆服务里这个 profile 的卡片（含被取代的历史版本，版本链连边）。
 *
 * 边：记忆小节按时间串成链；小节正文提到技能名 → 连到技能；卡片的取代关系连成版本链。
 *
 * 读文件的纪律：路径来自引擎名册（不是请求数据），仍然只经 `readTextFileSafe`（普通文件判定，命名管道挂不住）、
 * 限大小，技能目录下的软链 realpath 后必须仍在工作区里；外部运行时（`ext:` 开头）没有工作区，只有记忆卡片。
 */
import fs from 'fs';
import path from 'path';

import { readTextFileSafe } from '../../openclaw';
import type { EngineRoster } from '../shared/engine-roster';

export const JOURNEY_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const JOURNEY_MAX_SKILLS = 500;
export const JOURNEY_MAX_DAILY_NOTES = 1000;
export const JOURNEY_DETAIL_CHARS = 600;

export type JourneyNodeKind = 'memory' | 'daily' | 'skill' | 'card';

export type JourneyNode = {
  id: string;
  kind: JourneyNodeKind;
  label: string;
  /** 这个节点「出现」的时间（ISO）。时间回放按它排序。 */
  timestamp: string;
  /** 最后一次变化（技能的修改时间、卡片的更新时间）。 */
  modifiedAt: string | null;
  category: string;
  detail: string;
  source: string | null;
  createdBy: 'agent' | 'pending' | 'unknown' | 'user' | null;
  state: string | null;
};

export type JourneyEdge = { id: string; source: string; target: string; kind: 'sequence' | 'mentions' | 'revision' };

export type JourneyGraph = {
  agentId: string;
  workspaceAvailable: boolean;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  clusters: Array<{ category: string; count: number }>;
  stats: { memory: number; daily: number; skills: number; agentSkills: number; cards: number; first: string | null; last: string | null };
  truncated: boolean;
};

export type JourneyDeps = {
  engineRoster: Pick<EngineRoster, 'get'>;
  agentProvisioner: { getWorkspacePath(agentId: string): string };
  writeGate: {
    listHistory(agentId: string, limit?: number): Array<{ relPath: string; decision: string; action: string }>;
    listPending(agentId?: string): { records: Array<{ relPath: string; action: string }> };
  };
  memory: { listAllForProfile(profileId: string): Array<{ id: string; title: string; content: string; kind: string; categoryPath: string; status: string; createdAt: string; updatedAt: string; supersedesId: string | null; actor?: string }> };
};

const DATE_HEADING = /^(#{1,4})\s+(?:.*?)(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b(.*)$/;

const iso = (ms: number) => new Date(ms).toISOString();

function validDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (y < 1970 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString();
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > JOURNEY_DETAIL_CHARS ? `${trimmed.slice(0, JOURNEY_DETAIL_CHARS)}…` : trimmed;
}

/** MEMORY.md → 带日期标题的小节（标题层级内到下一个同级或更高级标题为止）。 */
export function parseDatedMemorySections(markdown: string): Array<{ date: string; title: string; body: string; line: number }> {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ date: string; title: string; body: string; line: number; level: number }> = [];
  let current: { date: string; title: string; bodyLines: string[]; line: number; level: number } | null = null;
  let inFence = false;
  const flush = () => {
    if (current) sections.push({ date: current.date, title: current.title, body: current.bodyLines.join('\n').trim(), line: current.line, level: current.level });
    current = null;
  };
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const dated = DATE_HEADING.exec(line);
      const date = dated ? validDate(dated[2], dated[3], dated[4]) : null;
      if (date && level <= 4) {
        flush();
        current = { date, title: heading[2].trim(), bodyLines: [], line: index + 1, level };
        return;
      }
      if (current && level <= current.level) {
        flush();
        return;
      }
    }
    if (current) current.bodyLines.push(line);
  });
  flush();
  return sections.map(({ date, title, body, line }) => ({ date, title, body, line }));
}

/** SKILL.md 的 frontmatter（只取几个简单键，不做完整 YAML）。 */
export function parseSkillFrontmatter(markdown: string): { name: string | null; description: string | null; category: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const read = (key: string) => {
    if (!match) return null;
    const line = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(match[1]);
    if (!line) return null;
    return line[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 300) || null;
  };
  return { name: read('name'), description: read('description'), category: read('category') };
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readSmallText(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > JOURNEY_MAX_FILE_BYTES) return null;
    const result = readTextFileSafe(filePath);
    return result.exists && typeof result.value === 'string' ? result.value : null;
  } catch {
    return null;
  }
}

export function createJourneyService(deps: JourneyDeps) {
  async function resolveWorkspace(agentId: string): Promise<string | null> {
    if (agentId.startsWith('ext:')) return null;
    let workspace: string | null = null;
    try {
      workspace = (await deps.engineRoster.get(agentId)).workspace;
    } catch {
      workspace = null;
    }
    const candidate = workspace ?? deps.agentProvisioner.getWorkspacePath(agentId);
    try {
      return fs.statSync(candidate).isDirectory() ? fs.realpathSync(candidate) : null;
    } catch {
      return null;
    }
  }

  function memoryNodes(workspace: string): JourneyNode[] {
    const text = readSmallText(path.join(workspace, 'MEMORY.md'));
    if (!text) return [];
    return parseDatedMemorySections(text).map((section, index) => ({
      id: `memory:${index}:${section.line}`,
      kind: 'memory' as const,
      label: section.title,
      timestamp: section.date,
      modifiedAt: null,
      category: 'memory',
      detail: clip(section.body),
      source: `MEMORY.md#L${section.line}`,
      createdBy: null,
      state: null,
    }));
  }

  function dailyNodes(workspace: string): JourneyNode[] {
    const dir = path.join(workspace, 'memory');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: JourneyNode[] = [];
    for (const entry of entries.filter((item) => item.isFile() && /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(-JOURNEY_MAX_DAILY_NOTES)) {
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(entry.name)!;
      const date = validDate(match[1], match[2], match[3]);
      if (!date) continue;
      const text = readSmallText(path.join(dir, entry.name)) ?? '';
      const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim();
      nodes.push({
        id: `daily:${entry.name}`,
        kind: 'daily',
        label: heading ? heading.slice(0, 120) : entry.name.replace(/\.md$/i, ''),
        timestamp: date,
        modifiedAt: null,
        category: 'daily',
        detail: clip(text.replace(/^#{1,3}\s+.+$/m, '')),
        source: `memory/${entry.name}`,
        createdBy: null,
        state: null,
      });
    }
    return nodes;
  }

  function skillNodes(agentId: string, workspace: string): { nodes: JourneyNode[]; truncated: boolean } {
    const dir = path.join(workspace, 'skills');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { nodes: [], truncated: false };
    }
    const history = deps.writeGate.listHistory(agentId, 5000);
    const pending = deps.writeGate.listPending(agentId).records;
    const candidates = entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name));
    const nodes: JourneyNode[] = [];
    for (const entry of candidates.slice(0, JOURNEY_MAX_SKILLS)) {
      const skillDir = path.join(dir, entry.name);
      let realDir: string;
      try {
        realDir = fs.realpathSync(skillDir);
      } catch {
        continue;
      }
      // 软链逃出工作区的技能目录不读（名册里的路径可信，目录里的软链不一定）。
      if (!isInside(realDir, workspace)) continue;
      const skillFile = path.join(realDir, 'SKILL.md');
      let stat: fs.Stats;
      try {
        stat = fs.statSync(skillFile);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const meta = parseSkillFrontmatter(readSmallText(skillFile) ?? '');
      const prefix = `skills/${entry.name}/`;
      const approvedByGate = history.some((row) => row.relPath.startsWith(prefix) && row.decision === 'approved');
      const pendingInGate = pending.some((row) => row.relPath.startsWith(prefix));
      const created = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
      nodes.push({
        id: `skill:${entry.name}`,
        kind: 'skill',
        label: meta.name ?? entry.name,
        timestamp: iso(created),
        modifiedAt: iso(stat.mtimeMs),
        category: meta.category ?? 'skill',
        detail: meta.description ?? '',
        source: `${prefix}SKILL.md`,
        createdBy: approvedByGate ? 'agent' : pendingInGate ? 'pending' : 'unknown',
        state: pendingInGate ? 'pending' : 'active',
      });
    }
    return { nodes, truncated: candidates.length > JOURNEY_MAX_SKILLS };
  }

  function cardNodes(agentId: string): JourneyNode[] {
    let cards: ReturnType<JourneyDeps['memory']['listAllForProfile']>;
    try {
      cards = deps.memory.listAllForProfile(agentId);
    } catch {
      return [];
    }
    return cards.filter((card) => card.status !== 'deleted').map((card) => ({
      id: `card:${card.id}`,
      kind: 'card' as const,
      label: card.title,
      timestamp: card.createdAt,
      modifiedAt: card.updatedAt,
      category: card.categoryPath || card.kind,
      detail: clip(card.content),
      source: card.supersedesId ? `card:${card.supersedesId}` : null,
      createdBy: null,
      state: card.status,
    }));
  }

  async function graph(agentId: string): Promise<JourneyGraph> {
    const workspace = await resolveWorkspace(agentId);
    const memory = workspace ? memoryNodes(workspace) : [];
    const daily = workspace ? dailyNodes(workspace) : [];
    const skills = workspace ? skillNodes(agentId, workspace) : { nodes: [], truncated: false };
    const cards = cardNodes(agentId);
    const nodes = [...memory, ...daily, ...skills.nodes, ...cards].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id.localeCompare(b.id)));

    const edges: JourneyEdge[] = [];
    const timeline = nodes.filter((node) => node.kind === 'memory' || node.kind === 'daily');
    for (let index = 1; index < timeline.length; index += 1) {
      edges.push({ id: `seq:${timeline[index - 1].id}->${timeline[index].id}`, source: timeline[index - 1].id, target: timeline[index].id, kind: 'sequence' });
    }
    for (const skill of skills.nodes) {
      const names = [skill.label, skill.id.slice('skill:'.length)].filter((name) => name.length >= 3).map((name) => name.toLowerCase());
      for (const note of timeline) {
        const haystack = `${note.label}\n${note.detail}`.toLowerCase();
        if (names.some((name) => haystack.includes(name))) edges.push({ id: `mention:${note.id}->${skill.id}`, source: note.id, target: skill.id, kind: 'mentions' });
      }
    }
    const cardIds = new Set(cards.map((card) => card.id));
    for (const card of cards) {
      if (card.source && cardIds.has(card.source)) edges.push({ id: `rev:${card.source}->${card.id}`, source: card.source, target: card.id, kind: 'revision' });
    }

    const clusterCounts = new Map<string, number>();
    for (const node of nodes) clusterCounts.set(node.category, (clusterCounts.get(node.category) ?? 0) + 1);
    return {
      agentId,
      workspaceAvailable: Boolean(workspace),
      nodes,
      edges,
      clusters: [...clusterCounts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
      stats: {
        memory: memory.length,
        daily: daily.length,
        skills: skills.nodes.length,
        agentSkills: skills.nodes.filter((node) => node.createdBy === 'agent').length,
        cards: cards.length,
        first: nodes[0]?.timestamp ?? null,
        last: nodes[nodes.length - 1]?.timestamp ?? null,
      },
      truncated: skills.truncated,
    };
  }

  return { graph };
}

export type JourneyService = ReturnType<typeof createJourneyService>;
