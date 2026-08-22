/**
 * 智能体 / 团队打包（.clawpack）——把这台机器上的一个 Agent 或一个团队，
 * 打成一个可以发给别人、在对方机器上一键装回去的包。
 *
 * 格式：gzip 压缩的 JSON。选 JSON 不选 tar，是为了让包**可读可审**：
 *   gunzip -c team.clawpack | jq '.manifest'
 * 收到别人的包，装之前应当能看清楚里面有什么。文本文件原样存字符串，
 * 只有头像这类二进制才 base64。
 *
 * 三条硬规矩（都在 SECURITY.md 的红线上）：
 *   1. 凭据永不进包——auth-profiles.json、API key、网关 token 一律不导出，并对残留做扫描告警
 *   2. memory/ 日常记录与对话历史默认不带——那是导出者的私人数据
 *   3. 导入不执行任何东西——automations.sh 只写文件，定时任务由用户自己确认后再建
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export const PACK_FORMAT = 'clawpack';
export const PACK_FORMAT_VERSION = 1;

/** 单文件与整包上限。包是要发微信、走 URL 的，控制住体积也控制住风险面。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PACK_BYTES = 20 * 1024 * 1024;

/** 工作区根目录里允许进包的文件。白名单，不是黑名单。 */
const ROOT_FILE_WHITELIST = [
  'IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md',
  'HEARTBEAT.md', 'BOOT.md', 'BOOTSTRAP.md',
];
const OPTIONAL_MEMORY_FILE = 'MEMORY.md';
const OPTIONAL_AUTOMATION_FILE = 'automations.sh';

/** 允许进包的子目录。memory/ 不在其中——那是私人日志。 */
const DIR_WHITELIST = ['skills', 'reference', 'avatars'];

const SKIP_NAMES = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', 'auth-profiles.json']);
const SKIP_EXT = new Set(['.sqlite', '.key', '.pem', '.p12', '.log']);
const TEXT_EXT = new Set(['.md', '.sh', '.py', '.js', '.mjs', '.json', '.txt', '.html', '.css', '.yml', '.yaml', '.csv', '.mmd']);

/** 凭据残留扫描。命中只告警不阻断——除非命中的是明确的密钥形状。 */
const CREDENTIAL_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: 'openaiKey', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { code: 'githubToken', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { code: 'awsKey', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'privateKeyBlock', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'bearerToken', re: /\b[Bb]earer\s+[A-Za-z0-9._-]{24,}/ },
];

export type PackFile = {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  bytes: number;
};

export type PackAgent = {
  id: string;
  name: string;
  description?: string;
  runtime?: { runtimeMode?: string; systemPromptMode?: string; toolMode?: string; processStartTag?: string; processEndTag?: string };
  model?: { model?: string | null; fallbackMode?: string; fallbacks?: string[] };
  skills: string[];
  files: PackFile[];
};

export type PackTeam = {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  processStartTag?: string;
  processEndTag?: string;
  maxChainDepth?: number;
  members: Array<{ agentId: string; displayName: string; roleDescription?: string; position?: number }>;
};

export type PackWarning = { code: string; detail?: string };

export type PackManifest = {
  name: string;
  summary: string;
  agentCount: number;
  skillCount: number;
  fileCount: number;
  totalBytes: number;
  includesMemory: boolean;
  includesAutomations: boolean;
  riskySkills: Array<{ agentId: string; skill: string; tools: string; exec: boolean; network: boolean }>;
  warnings: PackWarning[];
};

export type ClawPack = {
  format: typeof PACK_FORMAT;
  formatVersion: number;
  kind: 'agent' | 'team';
  exportedAt: string;
  exportedBy: { app: string; version: string };
  manifest: PackManifest;
  team: PackTeam | null;
  agents: PackAgent[];
};

export type ExportOptions = {
  /** 带上 MEMORY.md（长期记忆骨架）。memory/ 日志任何情况下都不带。 */
  includeMemory?: boolean;
  /** 带上 automations.sh（定时任务脚本，导入方不会自动执行）。 */
  includeAutomations?: boolean;
  /** 带上模型与降级链配置。对方不一定有同样的模型，默认不带。 */
  includeModelConfig?: boolean;
};

function isTextFile(filePath: string): boolean {
  return TEXT_EXT.has(path.extname(filePath).toLowerCase());
}

function collectDir(rootDir: string, relDir: string, out: PackFile[], warnings: PackWarning[]) {
  const absDir = path.join(rootDir, relDir);
  if (!fs.existsSync(absDir)) return;
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const rel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      collectDir(rootDir, rel, out, warnings);
      continue;
    }
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    const abs = path.join(rootDir, rel);
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push({ code: 'fileTooLarge', detail: rel });
      continue;
    }
    const buf = fs.readFileSync(abs);
    out.push(isTextFile(rel)
      ? { path: rel, encoding: 'utf8', content: buf.toString('utf-8'), bytes: stat.size }
      : { path: rel, encoding: 'base64', content: buf.toString('base64'), bytes: stat.size });
  }
}

function scanCredentials(files: PackFile[], warnings: PackWarning[]) {
  for (const file of files) {
    if (file.encoding !== 'utf8') continue;
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.re.test(file.content)) {
        warnings.push({ code: `credential.${pattern.code}`, detail: file.path });
      }
    }
  }
}

/**
 * 技能声明了哪些值得导入方注意的工具。
 * **只标能跑命令（exec / Bash / shell / process）和能联网（web_fetch / web_search）的。**
 * Write 不标——技能写自己工作区是常态，把它算成风险等于把告警变成噪音，
 * 而噪音化的告警等于没有告警。
 */
function scanRiskySkills(agentId: string, files: PackFile[]): Array<{ agentId: string; skill: string; tools: string; exec: boolean; network: boolean }> {
  const flagged: Array<{ agentId: string; skill: string; tools: string; exec: boolean; network: boolean }> = [];
  for (const file of files) {
    if (file.encoding !== 'utf8') continue;
    if (!/^skills\/[^/]+\/SKILL\.md$/.test(file.path)) continue;
    const match = /^allowed-tools:\s*(.+)$/m.exec(file.content);
    if (!match) continue;
    const tools = match[1].trim();
    const exec = /\b(exec|Bash|shell|process)\b/i.test(tools);
    const network = /\b(web_fetch|web_search|WebFetch|WebSearch)\b/i.test(tools);
    if (exec || network) {
      flagged.push({ agentId, skill: file.path.split('/')[1], tools, exec, network });
    }
  }
  return flagged;
}

export function buildAgentEntry(
  agentId: string,
  displayName: string,
  workspaceDir: string,
  options: ExportOptions,
  warnings: PackWarning[],
): PackAgent {
  const files: PackFile[] = [];

  const pushRootFile = (name: string) => {
    const abs = path.join(workspaceDir, name);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return;
    const buf = fs.readFileSync(abs);
    if (buf.byteLength > MAX_FILE_BYTES) {
      warnings.push({ code: 'fileTooLarge', detail: name });
      return;
    }
    files.push({ path: name, encoding: 'utf8', content: buf.toString('utf-8'), bytes: buf.byteLength });
  };

  for (const name of ROOT_FILE_WHITELIST) pushRootFile(name);
  if (options.includeMemory) pushRootFile(OPTIONAL_MEMORY_FILE);
  if (options.includeAutomations) pushRootFile(OPTIONAL_AUTOMATION_FILE);
  for (const dir of DIR_WHITELIST) collectDir(workspaceDir, dir, files, warnings);

  scanCredentials(files, warnings);

  const skills = files
    .filter(f => /^skills\/[^/]+\/SKILL\.md$/.test(f.path))
    .map(f => f.path.split('/')[1])
    .sort();

  return { id: agentId, name: displayName, skills, files };
}

export function buildPack(input: {
  kind: 'agent' | 'team';
  name: string;
  summary: string;
  appVersion: string;
  agents: PackAgent[];
  team: PackTeam | null;
  options: ExportOptions;
  warnings: PackWarning[];
}): ClawPack {
  const { agents, warnings } = input;
  const fileCount = agents.reduce((sum, a) => sum + a.files.length, 0);
  const totalBytes = agents.reduce((sum, a) => sum + a.files.reduce((s, f) => s + f.bytes, 0), 0);
  const riskySkills = agents.flatMap(a => scanRiskySkills(a.id, a.files));
  const includesAutomations = agents.some(a => a.files.some(f => f.path === OPTIONAL_AUTOMATION_FILE));

  return {
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    kind: input.kind,
    exportedAt: new Date().toISOString(),
    exportedBy: { app: 'ClawOPT', version: input.appVersion },
    manifest: {
      name: input.name,
      summary: input.summary,
      agentCount: agents.length,
      skillCount: agents.reduce((sum, a) => sum + a.skills.length, 0),
      fileCount,
      totalBytes,
      includesMemory: agents.some(a => a.files.some(f => f.path === OPTIONAL_MEMORY_FILE)),
      includesAutomations,
      riskySkills,
      warnings,
    },
    team: input.team,
    agents,
  };
}

export function serializePack(pack: ClawPack): Buffer {
  return zlib.gzipSync(Buffer.from(JSON.stringify(pack, null, 1), 'utf-8'), { level: 9 });
}

export class PackError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

/** 路径必须落在工作区白名单内。这是导入侧最重要的一道闸门。 */
export function assertSafeRelPath(relPath: string): void {
  if (typeof relPath !== 'string' || !relPath) throw new PackError('packs.invalidPath', relPath);
  if (relPath.includes('\\') || relPath.includes('\0')) throw new PackError('packs.invalidPath', relPath);
  if (path.posix.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) throw new PackError('packs.invalidPath', relPath);
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) throw new PackError('packs.invalidPath', relPath);
  const top = normalized.split('/')[0];
  const isRootFile = normalized === top;
  if (isRootFile) {
    const allowed = [...ROOT_FILE_WHITELIST, OPTIONAL_MEMORY_FILE, OPTIONAL_AUTOMATION_FILE];
    if (!allowed.includes(top)) throw new PackError('packs.pathNotAllowed', relPath);
    return;
  }
  if (!DIR_WHITELIST.includes(top)) throw new PackError('packs.pathNotAllowed', relPath);
}

export function parsePack(raw: Buffer): ClawPack {
  if (raw.byteLength > MAX_PACK_BYTES) throw new PackError('packs.tooLarge');
  let text: string;
  try {
    const isGzip = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    text = (isGzip ? zlib.gunzipSync(raw) : raw).toString('utf-8');
  } catch {
    throw new PackError('packs.unreadable');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PackError('packs.unreadable');
  }

  if (parsed?.format !== PACK_FORMAT) throw new PackError('packs.notAPack');
  if (Number(parsed?.formatVersion) > PACK_FORMAT_VERSION) throw new PackError('packs.versionTooNew');
  if (!Array.isArray(parsed?.agents) || !parsed.agents.length) throw new PackError('packs.noAgents');

  for (const agent of parsed.agents) {
    if (typeof agent?.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(agent.id)) {
      throw new PackError('packs.invalidAgentId', String(agent?.id || ''));
    }
    if (!Array.isArray(agent.files)) throw new PackError('packs.unreadable');
    for (const file of agent.files) {
      assertSafeRelPath(file?.path);
      if (file.encoding !== 'utf8' && file.encoding !== 'base64') throw new PackError('packs.unreadable');
      if (typeof file.content !== 'string') throw new PackError('packs.unreadable');
    }
  }

  return parsed as ClawPack;
}

/** 把一个 Agent 的文件写进目标工作区。**只写文件，不执行任何东西。** */
export function writeAgentFiles(agent: PackAgent, workspaceDir: string): number {
  fs.mkdirSync(workspaceDir, { recursive: true });
  let written = 0;
  for (const file of agent.files) {
    assertSafeRelPath(file.path);
    const target = path.join(workspaceDir, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : Buffer.from(file.content, 'utf-8'));
    if (file.path === OPTIONAL_AUTOMATION_FILE) {
      try { fs.chmodSync(target, 0o755); } catch { /* 权限设不上不阻断导入 */ }
    }
    written++;
  }
  return written;
}

export function readPackFile(agent: PackAgent, relPath: string): string {
  const file = agent.files.find(f => f.path === relPath);
  if (!file) return '';
  return file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf-8') : file.content;
}

export function sanitizeFileName(name: string): string {
  return (name || 'clawpack').replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clawpack';
}
