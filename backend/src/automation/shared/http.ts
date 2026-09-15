import type express from 'express';

import { buildStructuredApiError } from '../../core/http';
import { AutomationError } from './errors';

type Handler = (req: express.Request, res: express.Response) => unknown | Promise<unknown>;

/** 包一层：AutomationError → 结构化错误（messageCode + params）；其余 → 500，detail 只给 message。 */
export function handle(fn: Handler): express.RequestHandler {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (!res.headersSent && result !== undefined) res.json(result);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof AutomationError) {
        res.status(error.status).json(buildStructuredApiError(error.code, error.message === error.code ? null : error.message, error.params));
        return;
      }
      console.error('[Automation] request failed:', (error as Error)?.message);
      res.status(500).json(buildStructuredApiError('automation.internalError', (error as Error)?.message ?? null));
    }
  };
}

export const bodyOf = (req: express.Request): Record<string, unknown> =>
  (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;

export function openSse(res: express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write('retry: 2000\n\n');
}
