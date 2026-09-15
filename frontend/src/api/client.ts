// 前端唯一的 HTTP 出口。
//
// 刻意基于 fetch 而不是 axios：现有调用全部是 fetch 语义——非 2xx 不抛错、
// 调用方自己读 `res.ok` / `data.success`、流式接口直接读 `response.body`。
// 换成 axios 会让每个调用点的错误分支悄悄改道，而 P0 的约束是行为不变。
//
// 鉴权走 httpOnly cookie：同源请求默认携带（credentials 默认 same-origin），这里不设额外头。

export const API_BASE = '/api';

/** 以 `/api` 为前缀发请求，返回原始 Response，解析与错误处理留给调用方。 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API_BASE}${path}`, init);
}

/**
 * JSON 请求体：`Content-Type: application/json` + `JSON.stringify(body)`。
 * 原调用点里的 `buildHeaders(true)` / `buildUpdateRequestHeaders(true)` 产出的正是这一个头，
 * 不带参数的版本产出空对象，与不传 headers 在线上等价，所以统一收口到这里。
 */
export function jsonInit(method: string, body: unknown, init?: RequestInit): RequestInit {
  return {
    ...init,
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** 带超时的 JSON GET：超时即 abort，调用方按原样 catch。 */
export async function apiJsonWithTimeout<T>(path: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await apiFetch(path, { ...init, signal: controller.signal });
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
