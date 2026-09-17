/**
 * 本地后端：全部 fs 经 `file-manager-fs.ts` 网关（包含判定在网关里按 realpath 做）。
 * 这里补一道：软链在根内指向的**真实目标**也要过敏感文件判据（`note.txt -> .env` 这种）。
 */
import path from 'path';

import { fmError } from '../file-manager-errors';
import {
  copyEntry,
  listDirReal,
  makeDir,
  moveLocalFile,
  openRegularReadStream,
  readRegularFile,
  realRoot,
  removeEntry,
  renameEntry,
  resolveExisting,
  resolveForCreate,
  resolveLinkItself,
  statReal,
  writeAtomic,
} from '../file-manager-fs';
import { isDeniedRelativePath, joinRelative } from '../path-policy';
import type { FileBackend, FileEntry } from './types';

export function createLocalBackend(rootPath: string): FileBackend {
  const existingReal = async (relPath: string): Promise<string> => {
    const real = await resolveExisting(rootPath, relPath);
    const rootReal = await realRoot(rootPath);
    const realRel = path.relative(rootReal, real).split(path.sep).join('/');
    if (isDeniedRelativePath(realRel)) throw fmError.deniedFile();
    return real;
  };

  return {
    kind: 'local',
    async list(relDir) {
      const real = await existingReal(relDir);
      const entries = await listDirReal(real);
      return entries.map((entry): FileEntry => ({ name: entry.name, path: joinRelative(relDir, entry.name), kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs }));
    },
    async stat(relPath) {
      const real = await existingReal(relPath);
      const stat = await statReal(real);
      return { name: relPath ? path.posix.basename(relPath) : '', path: relPath, kind: stat.kind, size: stat.size, mtimeMs: stat.mtimeMs };
    },
    async read(relPath, maxBytes) {
      return readRegularFile(await existingReal(relPath), maxBytes);
    },
    async write(relPath, data) {
      await writeAtomic(await resolveForCreate(rootPath, relPath), data);
    },
    async writeFromLocalFile(relPath, localFile, options) {
      await moveLocalFile(localFile, await resolveForCreate(rootPath, relPath), options.overwrite);
    },
    async mkdir(relPath) {
      await makeDir(await resolveForCreate(rootPath, relPath));
    },
    async rename(fromRel, toRel) {
      const from = await resolveLinkItself(rootPath, fromRel);
      if (!from.exists) throw fmError.notFound();
      await renameEntry(from.path, await resolveForCreate(rootPath, toRel));
    },
    async copy(fromRel, toRel) {
      await copyEntry(await existingReal(fromRel), await resolveForCreate(rootPath, toRel));
    },
    async remove(relPath, options) {
      if (!relPath) throw fmError.invalidPath();
      const target = await resolveLinkItself(rootPath, relPath);
      if (!target.exists) throw fmError.notFound();
      await removeEntry(target.path, options.recursive);
    },
    async openReadStream(relPath, maxBytes) {
      return openRegularReadStream(await existingReal(relPath), maxBytes);
    },
    async localRealPath(relPath) {
      return existingReal(relPath);
    },
  };
}
