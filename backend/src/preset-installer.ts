/**
 * 预设装配（内容层）——把 presets/<id> 装成正在运行的 Agent。
 *
 * 为什么单独一个模块：Gateway 的 POST /api/sessions 只覆盖 6 份 markdown
 * （IDENTITY / SOUL / AGENTS / USER / TOOLS / HEARTBEAT），而一套预设真正值钱的部分
 * ——MEMORY.md、skills/、reference/、automations.sh——API 一处都不管（见 docs/preset-gap.md）。
 * 所以装配必须分两条路：Agent 建好之后，剩下的直接写工作区目录。
 *
 * 本模块只做纯文件侧的事（读清单、填占位符、写工作区），不碰 sessionManager /
 * agentProvisioner；那两个由 index.ts 的路由注入，模块本身可单独测试。
 */
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PRESETS_DIR = path.join(REPO_ROOT, 'presets');

export type PresetParam = {
  key: string;
  label?: string;
  hint?: string;
  default?: string;
  examples?: string[];
};

export type PresetRole = {
  id: string;
  name: string;
  emoji?: string;
  position?: string;
  slogan?: string;
  skills?: string[];
  externalSkills?: string[];
  recommended?: boolean;
  note?: string;
};

export type PresetDefinition = {
  id: string;
  version?: string;
  name: string;
  nameEn?: string;
  tagline?: string;
  description?: string;
  author?: string;
  license?: string;
  params: PresetParam[];
  roles: PresetRole[];
  apiFiles?: Record<string, string>;
  workspaceFiles?: { files?: string[]; dirs?: string[]; scripts?: string[] };
  postInstall?: string[];
};

export type PresetSummary = {
  id: string;
  name: string;
  tagline?: string;
  /** 角色数：扫目录得出，不读清单里的手写值。 */
  roleCount: number;
  /** 技能数：扫目录得出。 */
  skillCount: number;
  recommended?: boolean;
  /**
   * 这套预设为什么装不了，能装时为 undefined。
   *
   * 坏掉的预设**留在名册上**而不是被静默过滤：目录还占着那个 id，过滤掉之后
   * 界面上没有任何东西可看、可删，而下一次有人用同名新建又会被拒。
   */
  broken?: string;
};

export type RoleInstallPlan = {
  roleId: string;
  name: string;
  emoji?: string;
  /** 6 份 markdown 合计字符数，占位符已填 */
  markdownChars: number;
  /** API 覆盖不到、需要直接写工作区的文件数 */
  workspaceFileCount: number;
  skillNames: string[];
  externalSkills: string[];
  workspaceDir: string;
  exists: boolean;
};

/** 占位符只在文本类文件里替换。二进制（头像等）原样拷贝。 */
const FILLABLE_EXT = new Set(['.md', '.sh', '.json', '.txt', '.py', '.html', '.mjs', '.js', '.yml', '.yaml']);

export function fillPlaceholders(text: string, vals: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => (key in vals ? vals[key] : whole));
}

function readFilled(filePath: string, vals: Record<string, string>): string {
  if (!fs.existsSync(filePath)) return '';
  return fillPlaceholders(fs.readFileSync(filePath, 'utf-8'), vals);
}

function copyDirFilled(src: string, dst: string, vals: Record<string, string>): number {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      count += copyDirFilled(from, to, vals);
      continue;
    }
    if (FILLABLE_EXT.has(path.extname(entry.name))) {
      fs.writeFileSync(to, fillPlaceholders(fs.readFileSync(from, 'utf-8'), vals));
    } else {
      fs.copyFileSync(from, to);
    }
    count++;
  }
  return count;
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

/** 一套预设里所有角色的技能目录数之和（`_` 开头的分拣目录不算）。 */
function countPresetSkills(presetId: string): number {
  const rolesDir = path.join(PRESETS_DIR, presetId, 'roles');
  if (!fs.existsSync(rolesDir)) return 0;
  let total = 0;
  for (const role of fs.readdirSync(rolesDir, { withFileTypes: true })) {
    if (!role.isDirectory()) continue;
    const skillsDir = path.join(rolesDir, role.name, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (skill.isDirectory() && !skill.name.startsWith('_')
        && fs.existsSync(path.join(skillsDir, skill.name, 'SKILL.md'))) total++;
    }
  }
  return total;
}

/**
 * 名册就是目录本身。
 *
 * `manifest.json` 只登记 id / 展示文案 / 是否推荐；角色数与技能数一律扫目录得出。
 * 清单里手写一份计数就是第二份要同步的清单，而它会是最先过期的那一份——这个仓库
 * 已经犯过一次：技能从 14 个涨到 21 个之后，`skillCount: 14` 在清单里躺了很久。
 */
export function listPresets(): PresetSummary[] {
  const manifestPath = path.join(PRESETS_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  let entries: any[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    entries = Array.isArray(manifest?.presets) ? manifest.presets : [];
  } catch {
    return [];
  }

  const summaries: PresetSummary[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string') continue;
    const dir = path.join(PRESETS_DIR, entry.path || entry.id);
    const definition = loadPreset(entry.id);
    const broken = !fs.existsSync(dir)
      ? '预设目录不存在'
      : !fs.existsSync(path.join(dir, 'preset.json'))
        ? '缺少 preset.json'
        : definition === null
          ? 'preset.json 解析失败'
          : definition.roles.length === 0
            ? 'preset.json 里没有任何角色'
            : undefined;

    summaries.push({
      id: entry.id,
      name: definition?.name || entry.name || entry.id,
      tagline: definition?.tagline || entry.tagline,
      roleCount: definition?.roles.length ?? 0,
      skillCount: countPresetSkills(entry.id),
      recommended: entry.recommended === true,
      ...broken === undefined ? {} : { broken },
    });
  }
  return summaries;
}

export function loadPreset(presetId: string): PresetDefinition | null {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(presetId)) return null;   // 目录穿越防线
  const file = path.join(PRESETS_DIR, presetId, 'preset.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      ...parsed,
      params: Array.isArray(parsed.params) ? parsed.params : [],
      roles: Array.isArray(parsed.roles) ? parsed.roles : [],
    } as PresetDefinition;
  } catch {
    return null;
  }
}

export function resolveParamValues(preset: PresetDefinition, provided: Record<string, unknown> | undefined): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const param of preset.params) {
    const raw = provided?.[param.key];
    const value = typeof raw === 'string' && raw.trim() ? raw.trim() : (param.default ?? '');
    vals[param.key] = value;
  }
  return vals;
}

function roleDir(presetId: string, roleId: string): string {
  return path.join(PRESETS_DIR, presetId, 'roles', roleId);
}

/** 6 份可走 API 的 markdown，占位符已填。 */
export function buildRolePayload(presetId: string, role: PresetRole, vals: Record<string, string>) {
  const dir = roleDir(presetId, role.id);
  return {
    identityContent: readFilled(path.join(dir, 'IDENTITY.md'), vals),
    soulContent: readFilled(path.join(dir, 'SOUL.md'), vals),
    agentsContent: readFilled(path.join(dir, 'AGENTS.md'), vals),
    userContent: readFilled(path.join(dir, 'USER.md'), vals),
    toolsContent: readFilled(path.join(dir, 'TOOLS.md'), vals),
    heartbeatContent: readFilled(path.join(dir, 'HEARTBEAT.md'), vals),
  };
}

export function planRole(
  presetId: string,
  preset: PresetDefinition,
  role: PresetRole,
  vals: Record<string, string>,
  workspaceDir: string,
  agentExists: boolean,
): RoleInstallPlan {
  const dir = roleDir(presetId, role.id);
  const payload = buildRolePayload(presetId, role, vals);
  const markdownChars = Object.values(payload).reduce((sum, text) => sum + text.length, 0);

  const spec = preset.workspaceFiles || {};
  let workspaceFileCount = 0;
  for (const f of spec.files || []) if (fs.existsSync(path.join(dir, f))) workspaceFileCount++;
  for (const d of spec.dirs || []) workspaceFileCount += countFiles(path.join(dir, d.replace(/\/$/, '')));
  for (const s of spec.scripts || []) if (fs.existsSync(path.join(dir, s))) workspaceFileCount++;

  const skillsDir = path.join(dir, 'skills');
  const skillNames = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('_') && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
        .map(e => e.name)
        .sort()
    : [];

  return {
    roleId: role.id,
    name: role.name,
    emoji: role.emoji,
    markdownChars,
    workspaceFileCount,
    skillNames,
    externalSkills: role.externalSkills || [],
    workspaceDir,
    exists: agentExists,
  };
}

/**
 * 写 API 覆盖不到的部分：MEMORY.md / BOOTSTRAP.md / skills/ / reference/ / memory/ /
 * avatars/ / automations.sh。**在 provision() 之后调用**——provision 会建工作区目录。
 */
export function writeWorkspaceExtras(
  presetId: string,
  preset: PresetDefinition,
  role: PresetRole,
  vals: Record<string, string>,
  workspaceDir: string,
): number {
  const dir = roleDir(presetId, role.id);
  const spec = preset.workspaceFiles || {};
  fs.mkdirSync(workspaceDir, { recursive: true });
  let written = 0;

  for (const f of spec.files || []) {
    const from = path.join(dir, f);
    if (!fs.existsSync(from)) continue;
    fs.writeFileSync(path.join(workspaceDir, f), fillPlaceholders(fs.readFileSync(from, 'utf-8'), vals));
    written++;
  }
  for (const d of spec.dirs || []) {
    const rel = d.replace(/\/$/, '');
    written += copyDirFilled(path.join(dir, rel), path.join(workspaceDir, rel), vals);
  }
  for (const s of spec.scripts || []) {
    const from = path.join(dir, s);
    if (!fs.existsSync(from)) continue;
    const to = path.join(workspaceDir, s);
    fs.writeFileSync(to, fillPlaceholders(fs.readFileSync(from, 'utf-8'), vals));
    try { fs.chmodSync(to, 0o755); } catch { /* 权限设不上不阻断装配 */ }
    written++;
  }
  return written;
}

export function presetsDirExists(): boolean {
  return fs.existsSync(PRESETS_DIR);
}
