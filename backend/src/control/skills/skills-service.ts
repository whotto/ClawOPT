/**
 * 技能浏览：`openclaw skills list/info/check/search/install/update/verify` + 启停（`skills.entries.<key>.enabled`）。
 *
 * ## SKILL.md 的读取
 *
 * 详情页要渲染 SKILL.md。路径**不来自请求**：请求只给技能名（按白名单校验），
 * 路径由引擎的 `skills info --json` 报出（`filePath` / `baseDir`）。即便如此仍按出文件的纪律收紧：
 * 文件名必须恰好是 `SKILL.md`、realpath 必须正好是 `realpath(baseDir)/SKILL.md`（软链逃逸即拒）、
 * 必须是普通文件且不超过 1 MiB。捆绑技能住在 OpenClaw 安装目录里，不在 `served-paths` 的
 * 工作区 / 上传根之下，所以这里不复用 `assertServablePath()`，而是只放行这一个被引擎点名的文件。
 * 这个读取只进 JSON 响应体，不是按路径出文件的下载接口。
 */
import fs from 'fs';
import path from 'path';

import { redactLogValue } from '../../core/logger';
import { type OpenClawCliRunner, readTextFileSafe } from '../../openclaw';
import { AGENT_ID_PATTERN, ControlInputError, optionalString, requireString } from '../shared/control-http';

type Raw = Record<string, unknown>;

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SKILL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SKILL_REF_PATTERN = /^(@?[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*|git:https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+)$/;
const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;
const MAX_SKILL_MD_BYTES = 1024 * 1024;

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export type SkillView = {
  name: string;
  description: string | null;
  emoji: string | null;
  source: string | null;
  bundled: boolean;
  eligible: boolean;
  disabled: boolean;
  blocked: boolean;
  homepage: string | null;
  missing: Record<string, string[]>;
};

function normalizeMissing(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Raw)) {
    const items = arr(value).filter((item): item is string => typeof item === 'string');
    if (items.length) out[key] = items;
  }
  return out;
}

export function normalizeSkill(raw: Raw): SkillView {
  return {
    name: String(raw.name ?? ''),
    description: str(raw.description),
    emoji: str(raw.emoji),
    source: str(raw.source),
    bundled: raw.bundled === true,
    eligible: raw.eligible === true,
    disabled: raw.disabled === true,
    blocked: raw.blockedByAllowlist === true || raw.blockedByAgentFilter === true,
    homepage: str(raw.homepage),
    missing: normalizeMissing(raw.missing),
  };
}

export function assertSkillName(name: unknown): string {
  return requireString(name, 'skills.invalidName', { pattern: SKILL_NAME_PATTERN });
}

function agentArgs(agentId: unknown): string[] {
  const id = optionalString(agentId, 'skills.invalidAgent', { pattern: AGENT_ID_PATTERN });
  return id ? ['--agent', id] : [];
}

/** 只放行引擎点名的那一个 SKILL.md（判据见文件头）。读不到返回 null，不抛。 */
export function readEngineSkillMarkdown(filePath: unknown, baseDir: unknown): string | null {
  if (typeof filePath !== 'string' || typeof baseDir !== 'string') return null;
  if (path.basename(filePath) !== 'SKILL.md') return null;
  try {
    const realBase = fs.realpathSync(baseDir);
    const realFile = fs.realpathSync(filePath);
    if (realFile !== path.join(realBase, 'SKILL.md')) return null;
    const stat = fs.statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_SKILL_MD_BYTES) return null;
    const text = readTextFileSafe(realFile);
    return text.exists ? String(text.value) : null;
  } catch {
    return null;
  }
}

export function createSkillsService(deps: { openclawCli: OpenClawCliRunner }) {
  const cli = deps.openclawCli;

  async function list(agentId?: unknown) {
    const raw = await cli.runJson<Raw>(['skills', 'list', '--json', ...agentArgs(agentId)]);
    const skills = arr(raw.skills)
      .filter((entry): entry is Raw => !!entry && typeof entry === 'object')
      .map(normalizeSkill)
      .filter((skill) => skill.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { skills };
  }

  async function info(name: string, agentId?: unknown) {
    const raw = await cli.runJson<Raw>(['skills', 'info', assertSkillName(name), '--json', ...agentArgs(agentId)]);
    const markdown = readEngineSkillMarkdown(raw.filePath, raw.baseDir);
    return {
      ...normalizeSkill(raw),
      skillKey: str(raw.skillKey),
      always: raw.always === true,
      requirements: normalizeMissing(raw.requirements),
      install: redactLogValue(arr(raw.install)) as unknown[],
      markdown,
    };
  }

  async function check(agentId?: unknown) {
    const raw = await cli.runJson<Raw>(['skills', 'check', '--json', ...agentArgs(agentId)]);
    return { summary: raw.summary ?? null };
  }

  async function search(query: unknown) {
    const text = requireString(query, 'skills.invalidQuery', { max: 120 });
    const raw = await cli.runJson<Raw>(['skills', 'search', text, '--json', '--limit', '20'], { timeoutMs: 45_000 });
    const results = arr(raw.results).filter((entry): entry is Raw => !!entry && typeof entry === 'object').map((entry) => {
      const install = (entry.install && typeof entry.install === 'object' ? entry.install : {}) as Raw;
      const metrics = (entry.metrics && typeof entry.metrics === 'object' ? entry.metrics : {}) as Raw;
      return {
        id: str(entry.id),
        displayName: str(entry.displayName),
        summary: str(entry.summary) ?? str(entry.description),
        reference: str(install.reference),
        downloads: typeof entry.downloads === 'number' ? entry.downloads : null,
        updatedAt: typeof metrics.updatedAt === 'number' ? metrics.updatedAt : null,
      };
    });
    return { results };
  }

  function refArgs(ref: unknown): string {
    const text = requireString(ref, 'skills.invalidRef', { pattern: SKILL_REF_PATTERN, max: 300 });
    return text;
  }

  async function install(input: { ref: unknown; agentId?: unknown; global?: boolean; version?: unknown; acknowledgeRisk?: boolean }) {
    const version = optionalString(input.version, 'skills.invalidVersion', { pattern: VERSION_PATTERN });
    await cli.run([
      'skills', 'install', refArgs(input.ref),
      ...agentArgs(input.agentId),
      ...(input.global ? ['--global'] : []),
      ...(version ? ['--version', version] : []),
      ...(input.acknowledgeRisk ? ['--acknowledge-clawhub-risk'] : []),
    ], { mutating: true, timeoutMs: 5 * 60_000 });
  }

  async function update(input: { ref?: unknown; agentId?: unknown; global?: boolean; acknowledgeRisk?: boolean }) {
    const ref = input.ref ? refArgs(input.ref) : null;
    await cli.run([
      'skills', 'update', ...(ref ? [ref] : ['--all']),
      ...agentArgs(input.agentId),
      ...(input.global ? ['--global'] : []),
      ...(input.acknowledgeRisk ? ['--acknowledge-clawhub-risk'] : []),
    ], { mutating: true, timeoutMs: 5 * 60_000 });
  }

  async function verify(ref: unknown, agentId?: unknown) {
    const { stdout } = await cli.run(['skills', 'verify', refArgs(ref), ...agentArgs(agentId)], { timeoutMs: 60_000 });
    return { output: redactLogValue(stdout.slice(0, 20_000)) as string };
  }

  /** 启停写引擎配置 `skills.entries.<key>.enabled`（引擎会让会话在下一轮重建技能快照）。 */
  async function setEnabled(skillKey: unknown, enabled: boolean) {
    const key = requireString(skillKey, 'skills.invalidName', { pattern: SKILL_KEY_PATTERN });
    if (typeof enabled !== 'boolean') throw new ControlInputError('skills.invalidToggle');
    await cli.run(['config', 'set', `skills.entries.${key}.enabled`, String(enabled), '--strict-json'], { mutating: true });
  }

  return { list, info, check, search, install, update, verify, setEnabled };
}

export type SkillsService = ReturnType<typeof createSkillsService>;
