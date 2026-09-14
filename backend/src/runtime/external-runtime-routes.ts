import { buildStructuredApiError, type RouteApp } from '../core/http';
import { sanitizeErrorDetail } from '../openclaw';
import { resolveBinaryOnPath } from './binary-lookup';
import { buildExternalRuntimeList } from './external-agents/registry';

export function registerExternalRuntimeRoutes(app: RouteApp): void {
  /**
   * 这台主机上有哪些外部运行时可用。界面据此决定成员的运行时能不能选中——
   * 选一个主机上没有的，等于配好之后一 @ 就失败（生产机 2026-09-12 的实际状态）。
   */
  app.get('/api/external-runtimes', (_req, res) => {
    try {
      res.json({ success: true, runtimes: buildExternalRuntimeList(resolveBinaryOnPath) });
    } catch (error: unknown) {
      res.status(500).json(buildStructuredApiError('externalRuntimes.unavailable', sanitizeErrorDetail(error)));
    }
  });
}
