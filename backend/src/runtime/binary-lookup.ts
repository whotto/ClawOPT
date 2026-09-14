import path from 'path';
import fs from 'fs';

/**
 * 沿 PATH 找可执行文件。不 shell out 去跑 `command -v`——
 * `openclaw-version.ts` 为同一个原因也不 shell out：起进程的成败取决于谁的 PATH
 * 在前，而我们要问的只是「这个文件在不在」。
 */
export function resolveBinaryOnPath(name: string): boolean {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return true;
    } catch {
      // 单个目录不可读不该让整次探测失败
    }
  }
  return false;
}
