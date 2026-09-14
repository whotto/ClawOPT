import { StructuredRequestError } from '../http';
import { resolveServablePath } from './served-paths';

/**
 * 任何「按路径把文件交给浏览器」的入口都必须过这道闸门。
 *
 * 上一轮只给 /api/files/download 与 /openclaw 补了白名单，紧挨着的
 * preview / preview-data / html-preview 三个入口漏了——同一类洞，堵一个不堵其余
 * 等于没堵（实测可读 ~/.ssh/id_rsa 与 openclaw.json 里的模型 apiKey）。
 * 所以判定收敛到这一个函数，新增出文件的路由只要复用它就不会再漏。
 */
export function assertServablePath(absolutePath: string): string {
  const verdict = resolveServablePath(absolutePath);
  if (verdict.ok) return verdict.realPath;
  if (verdict.reason === 'notFound') throw new StructuredRequestError(404, 'files.notFound', 'File not found');
  console.warn(`[ServedPath Blocked] ${verdict.reason}: ${absolutePath}`);
  throw new StructuredRequestError(403, 'files.notServable', 'This file is not available');
}
