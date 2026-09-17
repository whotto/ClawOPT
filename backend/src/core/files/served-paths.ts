/**
 * 可服务路径闸门——决定哪些本地文件允许经 HTTP 交给浏览器。
 *
 * 背景：`/api/files/download` 原本只检查「是不是绝对路径」，等于把服务账号能读的
 * 每一个文件都开放给了任何能访问端口的人（私钥、`auth-profiles.json`、
 * `openclaw.json` 里的模型 key 都在内）；`/openclaw` 静态挂载把整个 `~/.openclaw`
 * 挂了出去，同样的问题。
 *
 * 这里换成白名单：只有智能体与群组工作区、外部运行时单聊的缺省工作区、上传目录下的文件可以被服务，且工作区内
 * 的凭据类文件仍然拒绝。路径先 realpath 再做归属判断，符号链接因此逃不出去。
 *
 * 判据顺序是「先解析真实路径，再判归属，最后判文件名」——反过来先看文件名的话，
 * 一个指向 `~/.ssh/id_rsa` 的软链接只要叫 `photo.png` 就能过。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 工作区内也不许外发的文件名（凭据、密钥、环境变量、数据库）。 */
const DENIED_BASENAMES = new Set([
  'auth-profiles.json',
  'openclaw.json',
  'credentials.json',
  '.env',
  '.htpasswd',
]);

const DENIED_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|ppk)$/i,
  /\.sqlite(-wal|-shm)?$/i,
  /^\.htpasswd/i,
];

/** 目录名命中即整棵子树拒绝。 */
const DENIED_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.config', 'agents', 'node_modules', '.git']);

export type ServedPathVerdict =
  | { ok: true; realPath: string }
  | { ok: false; reason: 'notAbsolute' | 'notFound' | 'outsideAllowedRoots' | 'deniedFile' };

function openclawRoot(): string {
  return path.join(os.homedir(), '.openclaw');
}

function dataUploadsRoot(): string {
  const dataDir = process.env.CLAWOPT_DATA_DIR || '.clawopt';
  return path.join(os.homedir(), dataDir, 'uploads');
}

/**
 * 外部运行时单聊没配工作目录时的缺省工作区的父目录（`collab/sessions/external-workspace.ts` 在这下面按会话 id 建目录）。
 * 自定义工作目录（`workingDir`）不在白名单里：那是任意本机路径，不因为「某个会话用过」就对浏览器开放。
 */
function externalSessionWorkspacesRoot(): string {
  const dataDir = process.env.CLAWOPT_DATA_DIR || '.clawopt';
  return path.join(os.homedir(), dataDir, 'workspaces', 'external');
}

/**
 * 真实存在的允许根，已 realpath。
 *
 * 只列**工作区**与上传目录：`~/.openclaw` 根目录本身不在其中，所以 `openclaw.json`
 * 与 `agents/` 下的凭据天然落在白名单之外，不必依赖文件名黑名单兜底。
 */
function allowedRoots(): string[] {
  const roots: string[] = [dataUploadsRoot(), externalSessionWorkspacesRoot()];
  const root = openclawRoot();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      // workspace-<agentId> 与 workspace-group-<groupId> 都以此为前缀
      if (entry.isDirectory() && entry.name.startsWith('workspace')) {
        roots.push(path.join(root, entry.name));
      }
    }
  } catch {
    // ~/.openclaw 不存在时没有工作区可服务，上传目录依然有效
  }
  return roots
    .map(candidate => {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 文件名是否属于凭据 / 密钥 / 环境变量 / 数据库这一类（与出文件闸门同一份判据）。
 * 工作区 diff 快照（`runtime/coordinator/workspace-diff`）据此连读都不读。
 */
export function isCredentialLikeFileName(basename: string): boolean {
  return DENIED_BASENAMES.has(basename) || DENIED_PATTERNS.some(pattern => pattern.test(basename));
}

function deniedByName(realPath: string, roots: string[]): boolean {
  const base = path.basename(realPath);
  if (isCredentialLikeFileName(base)) return true;

  const containing = roots.find(root => isInside(realPath, root));
  const relative = containing === undefined ? realPath : path.relative(containing, realPath);
  return relative.split(path.sep).some(segment => DENIED_DIR_SEGMENTS.has(segment));
}

/**
 * 相对路径（工作区内）是否落在凭据 / 密钥 / 数据库这类永不外发的名字上。与闸门同一份名单：
 * 群工作区文件编辑器、远程工作区令牌接口在**写入与新建**时用它（文件还不存在，走不了 realpath 闸门）。
 */
export function isSensitiveRelativePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1];
  if (DENIED_BASENAMES.has(base)) return true;
  if (DENIED_PATTERNS.some(pattern => pattern.test(base))) return true;
  return segments.some(segment => DENIED_DIR_SEGMENTS.has(segment));
}

/**
 * 判定一个绝对路径能否交给浏览器。
 * @param absolutePath 调用方解出的绝对路径。
 * @returns 通过时给出 realpath 后的真实路径，调用方应当用它去发送文件。
 */
export function resolveServablePath(absolutePath: string): ServedPathVerdict {
  if (!path.isAbsolute(absolutePath)) return { ok: false, reason: 'notAbsolute' };

  let realPath: string;
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    return { ok: false, reason: 'notFound' };
  }
  try {
    if (!fs.statSync(realPath).isFile()) return { ok: false, reason: 'notFound' };
  } catch {
    return { ok: false, reason: 'notFound' };
  }

  const roots = allowedRoots();
  if (!roots.some(root => isInside(realPath, root))) return { ok: false, reason: 'outsideAllowedRoots' };
  if (deniedByName(realPath, roots)) return { ok: false, reason: 'deniedFile' };

  return { ok: true, realPath };
}

/**
 * 一个已过闸门的文件归谁（数据面授权用，判据在 `core/auth/resource-access.ts`）：
 * - `~/.openclaw/workspace-group-<群>/…` → 群；
 * - `~/.openclaw/workspace-<Agent>/…` → Agent（`getWorkspacePath` 的命名就是这个）；
 * - 上传目录 → 看 `files` 表里登记的会话 / 群；
 * - `<数据目录>/workspaces/external/<目录名>/…` → 单聊会话（目录名就是会话 id 时；否则无主）；
 * - 其余（`~/.openclaw/workspace` 这类不带 id 的目录）→ 无主，只给管理员。
 *
 * 入参必须是 `resolveServablePath` 给出的 realPath：先过闸门、再判归属，顺序不能反。
 */
export type ServedPathOwner =
  | { kind: 'agent'; agentId: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'upload'; storedName: string }
  | { kind: 'chatSession'; sessionDir: string }
  | { kind: 'unowned' };

const GROUP_WORKSPACE_DIR_PREFIX = 'workspace-group-';
const AGENT_WORKSPACE_DIR_PREFIX = 'workspace-';

function realpathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export function servedPathOwner(realPath: string): ServedPathOwner {
  const uploadsRoot = realpathOrSelf(dataUploadsRoot());
  if (isInside(realPath, uploadsRoot)) return { kind: 'upload', storedName: path.basename(realPath) };
  const externalRoot = realpathOrSelf(externalSessionWorkspacesRoot());
  if (isInside(realPath, externalRoot)) {
    const [dir] = path.relative(externalRoot, realPath).split(path.sep);
    return dir && dir !== '..' && path.join(externalRoot, dir) !== realPath ? { kind: 'chatSession', sessionDir: dir } : { kind: 'unowned' };
  }
  const root = realpathOrSelf(openclawRoot());
  if (!isInside(realPath, root)) return { kind: 'unowned' };
  const [top] = path.relative(root, realPath).split(path.sep);
  if (top?.startsWith(GROUP_WORKSPACE_DIR_PREFIX) && top.length > GROUP_WORKSPACE_DIR_PREFIX.length) {
    return { kind: 'group', groupId: top.slice(GROUP_WORKSPACE_DIR_PREFIX.length) };
  }
  if (top?.startsWith(AGENT_WORKSPACE_DIR_PREFIX) && top.length > AGENT_WORKSPACE_DIR_PREFIX.length) {
    return { kind: 'agent', agentId: top.slice(AGENT_WORKSPACE_DIR_PREFIX.length) };
  }
  return { kind: 'unowned' };
}

/** 供诊断与测试使用：当前允许的根。 */
export function servableRoots(): string[] {
  return allowedRoots();
}
