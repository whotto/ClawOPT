/**
 * 语音模块的结构化错误：`voice.*` messageCode + HTTP 状态 + 已脱敏的诊断细节。
 */
export class VoiceError extends Error {
  constructor(
    readonly errorCode: string,
    readonly status = 400,
    readonly detail: string | null = null,
    readonly params: Record<string, string | number | boolean | null> | null = null,
  ) {
    super(errorCode);
    this.name = 'VoiceError';
  }
}

/** 从上游错误文本里抹掉 key 与令牌形状的片段；截断到 400 字。 */
export function sanitizeVoiceDetail(text: unknown, secrets: Array<string | null | undefined> = []): string {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  out = out
    .replace(/\b(sk|gsk|xi|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer[;\s]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|token|access[_-]?key|authorization|xi-api-key)"?\s*[:=]\s*"?)[^"\s,}]{4,}/gi, '$1[redacted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 400);
}
