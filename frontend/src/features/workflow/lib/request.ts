import type { TFunction } from 'i18next';

export type ApiError = { code: string; params: Record<string, unknown> | null; detail: string | null; status: number };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** 读后端 JSON；非 2xx 转成结构化错误（`errorCode` + `errorParams`），网络错误记 `automation.network`。 */
export async function requestJson<T>(request: Promise<Response>): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await request;
  } catch (error) {
    return { ok: false, error: { code: 'automation.network', params: null, detail: (error as Error)?.message ?? null, status: 0 } };
  }
  let body: any = null;
  if (response.status !== 204) {
    try {
      body = await response.json();
    } catch {
      body = null;
    }
  }
  if (response.ok) return { ok: true, data: body as T };
  return {
    ok: false,
    error: {
      code: typeof body?.errorCode === 'string' ? body.errorCode : 'automation.httpError',
      params: body?.errorParams ?? null,
      detail: typeof body?.errorDetail === 'string' ? body.errorDetail : typeof body?.error === 'string' ? body.error : null,
      status: response.status,
    },
  };
}

/** 错误码 → 本地化主句。`workflows.invalidGraph` 带 reason 时用图校验的原因文案。 */
export function describeError(t: TFunction, error: ApiError | { code: string; params?: Record<string, unknown> | null }): string {
  const params = (error.params ?? {}) as Record<string, unknown>;
  if ((error.code === 'workflows.invalidGraph' || error.code === 'workflows.importInvalid') && typeof params.reason === 'string') {
    const reasonKey = `automation.graph.${params.reason}`;
    const reason = t(reasonKey, params as Record<string, string>);
    if (reason !== reasonKey) return reason;
  }
  const key = `automation.errors.${error.code.replace(/\./g, '_')}`;
  const text = t(key, params as Record<string, string>);
  return text === key ? t('automation.errors.generic', { code: error.code }) : text;
}
