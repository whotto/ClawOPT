/**
 * 运行时 home 的文件操作：适配器唯一的 fs 出口，而且是**注入**的。
 *
 * 适配器先产出「要写哪些文件」（`PlannedFile[]`，纯数据，金样用例直接比它），
 * 再由这里落盘。三条规矩：
 *
 * 1. **不穿透符号链接写。** 影子 home 里有指向用户真实目录的软链（Codex 的 skills、OpenCode 的 plugins）；
 *    往一条软链上写，改的是用户自己的文件。目标是软链就拒绝。
 * 2. **原子写 + 0600。** 同目录临时文件、fsync、rename。运行时 home 里的文件含代理令牌与用户指令。
 * 3. **读只读普通文件。** 用户 home 下的配置是数据给的路径：命名管道会让读永久挂住，按 isFile 判。
 */
import fs from 'fs';
import path from 'path';

export type PlannedFile =
  | { kind: 'file'; path: string; content: string; mode?: number }
  | { kind: 'dir'; path: string }
  | { kind: 'symlink'; path: string; target: string };

export interface RuntimeFs {
  /** 不存在、不是普通文件、读失败都返回 null。 */
  readText(filePath: string): string | null;
  exists(filePath: string): boolean;
  isDirectory(filePath: string): boolean;
  /** 目录里的条目名；目录不存在返回空数组。 */
  listDir(dirPath: string): string[];
  mkdirp(dirPath: string): void;
  writeFile(filePath: string, content: string, mode?: number): void;
  symlink(target: string, linkPath: string): void;
  removeFile(filePath: string): void;
}

export class RuntimeFsError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export function createNodeRuntimeFs(): RuntimeFs {
  return {
    readText(filePath) {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return null;
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        return null;
      }
    },
    exists(filePath) {
      try {
        fs.lstatSync(filePath);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory(filePath) {
      try {
        return fs.statSync(filePath).isDirectory();
      } catch {
        return false;
      }
    },
    listDir(dirPath) {
      try {
        return fs.readdirSync(dirPath);
      } catch {
        return [];
      }
    },
    mkdirp(dirPath) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    },
    writeFile(filePath, content, mode = 0o600) {
      let existing: fs.Stats | null = null;
      try { existing = fs.lstatSync(filePath); } catch { existing = null; }
      if (existing?.isSymbolicLink()) {
        throw new RuntimeFsError(`refusing to write through symlink: ${path.basename(filePath)}`, 'runtime.homeSymlinkWrite');
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
      const fd = fs.openSync(tmp, 'wx', mode);
      try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, filePath);
      fs.chmodSync(filePath, mode);
    },
    symlink(target, linkPath) {
      let existing: fs.Stats | null = null;
      try { existing = fs.lstatSync(linkPath); } catch { existing = null; }
      if (existing && !existing.isSymbolicLink()) return; // 用户（或上一轮）放了真实目录：不覆盖
      if (existing) {
        if (fs.readlinkSync(linkPath) === target) return;
        fs.unlinkSync(linkPath);
      }
      fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o700 });
      fs.symlinkSync(target, linkPath);
    },
    removeFile(filePath) {
      try { fs.unlinkSync(filePath); } catch { /* 已不存在 */ }
    },
  };
}

/** 按顺序落盘。目录先建，文件原子写，软链只指向已存在的目标。 */
export function materializeFiles(files: readonly PlannedFile[], runtimeFs: RuntimeFs): void {
  for (const file of files) {
    if (file.kind === 'dir') runtimeFs.mkdirp(file.path);
  }
  for (const file of files) {
    if (file.kind === 'file') runtimeFs.writeFile(file.path, file.content, file.mode ?? 0o600);
    else if (file.kind === 'symlink' && runtimeFs.exists(file.target)) runtimeFs.symlink(file.target, file.path);
  }
}
