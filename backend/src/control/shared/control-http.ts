/**
 * 控制面路由的共用出口：输入校验错误、CLI 错误、未知错误 → 结构化 `errorCode`。
 *
 * 前端只认 `errorCode` 去本地化主句；`errorDetail` 是已脱敏的诊断信息，单独展示。
 */
import type express from 'express';

import { buildStructuredApiError, isStructuredRequestError, type StructuredMessageParams } from '../../core/http';
import { OpenClawCliError, sanitizeErrorDetail } from '../../openclaw';

export class ControlInputError extends Error {
  constructor(readonly errorCode: string, readonly status = 400, readonly params: StructuredMessageParams | null = null) {
    super(errorCode);
    this.name = 'ControlInputError';
  }
}

const CLI_STATUS: Record<string, number> = {
  'openclaw.cliMissing': 503,
  'openclaw.cliTimeout': 504,
  'openclaw.cliUnsupported': 501,
  'openclaw.pairingRequired': 409,
  'openclaw.gatewayUnreachable': 503,
  'openclaw.notFound': 404,
  'openclaw.cliBadJson': 502,
  'openclaw.cliFailed': 502,
  'openclaw.invalidProfile': 500,
};

export function sendControlError(res: express.Response, error: unknown): void {
  if (res.headersSent) return;
  if (error instanceof ControlInputError) {
    res.status(error.status).json(buildStructuredApiError(error.errorCode, null, error.params));
    return;
  }
  if (error instanceof OpenClawCliError) {
    res.status(CLI_STATUS[error.errorCode] ?? 502).json(buildStructuredApiError(error.errorCode, error.detail));
    return;
  }
  if (isStructuredRequestError(error)) {
    res.status(error.status).json(error.payload);
    return;
  }
  res.status(500).json(buildStructuredApiError('control.internalError', sanitizeErrorDetail(error)));
}

/** 异步处理器：抛出的一切都走 `sendControlError`，不落到 Express 默认的 `err.message` 出口。 */
export function controlHandler(handler: (req: express.Request, res: express.Response) => Promise<unknown> | unknown): express.RequestHandler {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => sendControlError(res, error));
  };
}

// ---- 输入校验小工具：每个都在不合法时抛 ControlInputError，调用处保持一行 ----

export function requireString(value: unknown, code: string, options: { max?: number; pattern?: RegExp; allowNewlines?: boolean } = {}): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new ControlInputError(code);
  if (options.max !== undefined && text.length > options.max) throw new ControlInputError(code);
  if (!options.allowNewlines && /[\r\n\0]/.test(text)) throw new ControlInputError(code);
  if (options.pattern && !options.pattern.test(text)) throw new ControlInputError(code);
  return text;
}

export function optionalString(value: unknown, code: string, options: { max?: number; pattern?: RegExp; allowNewlines?: boolean } = {}): string | null {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  return requireString(value, code, options);
}

export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
