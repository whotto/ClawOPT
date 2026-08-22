/**
 * 可服务路径闸门——决定哪些本地文件允许经 HTTP 交给浏览器。
 *
 * 背景：`/api/files/download` 原本只检查「是不是绝对路径」，等于把服务账号能读的
 * 每一个文件都开放给了任何能访问端口的人（私钥、`auth-profiles.json`、
 * `openclaw.json` 里的模型 key 都在内）；`/openclaw` 静态挂载把整个 `~/.openclaw`
 * 挂了出去，同样的问题。
 *
 * 这里换成白名单：只有智能体与群组工作区、上传目录下的文件可以被服务，且工作区内
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
 * 真实存在的允许根，已 realpath。
 *
 * 只列**工作区**与上传目录：`~/.openclaw` 根目录本身不在其中，所以 `openclaw.json`
 * 与 `agents/` 下的凭据天然落在白名单之外，不必依赖文件名黑名单兜底。
 */
function allowedRoots(): string[] {
  const roots: string[] = [dataUploadsRoot()];
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

function deniedByName(realPath: string, roots: string[]): boolean {
  const base = path.basename(realPath);
  if (DENIED_BASENAMES.has(base)) return true;
  if (DENIED_PATTERNS.some(pattern => pattern.test(base))) return true;

  const containing = roots.find(root => isInside(realPath, root));
  const relative = containing === undefined ? realPath : path.relative(containing, realPath);
  return relative.split(path.sep).some(segment => DENIED_DIR_SEGMENTS.has(segment));
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

/** 供诊断与测试使用：当前允许的根。 */
export function servableRoots(): string[] {
  return allowedRoots();
}
