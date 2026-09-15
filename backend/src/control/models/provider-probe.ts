/**
 * 服务商连通性测试 / 模型目录拉取（spec 05 F4 的加固版）。
 *
 * - **重定向只跟同源、最多 3 次**：请求头里带着 API key，跟到别的主机等于把 key 交出去；
 * - **8 秒超时、响应最多读 2 MiB、目录最多 1 万个模型**：一个坏上游不该拖垮后端；
 * - **`/models` 404/405 = 可达但没有目录**：很多兼容网关不实现目录接口，这不是「连不上」，
 *   界面提示「手动输入模型 ID」；401/403 单列为认证失败；
 * - Gemini 的 key 放 `x-goog-api-key` 头，不拼进查询串（查询串会进上游与代理的访问日志）。
 */

export type ProviderProbeInput = {
  baseUrl: string;
  api: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ProviderProbeResult =
  | { ok: true; catalogUnavailable: false; models: string[]; status: number }
  | { ok: true; catalogUnavailable: true; models: []; status: number }
  | { ok: false; errorCode: string; status: number | null; detail: string | null };

const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 10_000;

export function buildCatalogRequest(baseUrl: string, api: string, apiKey?: string | null): { url: string; headers: Record<string, string> } {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const kind = api.toLowerCase();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (kind.includes('anthropic')) {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    return { url: `${base}/models`, headers };
  }
  if (kind.includes('gemini') || kind.includes('google')) {
    if (apiKey) headers['x-goog-api-key'] = apiKey;
    return { url: `${base}/models`, headers };
  }
  if (kind.includes('ollama')) {
    return { url: `${base}/api/tags`, headers };
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { url: `${base}/models`, headers };
}

export function extractModelIds(payload: unknown): string[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : Array.isArray(payload) ? payload as unknown[] : [];
  const ids = list.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return '';
    const item = entry as Record<string, unknown>;
    return String(item.id ?? item.name ?? item.model ?? '');
  })
    .map((id) => id.trim().replace(/^models\//, ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf-8');
}

export async function probeProviderCatalog(input: ProviderProbeInput): Promise<ProviderProbeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let target: URL;
  try {
    target = new URL(buildCatalogRequest(input.baseUrl, input.api, input.apiKey).url);
  } catch {
    return { ok: false, errorCode: 'models.invalidBaseUrl', status: null, detail: null };
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:' || target.username || target.password) {
    return { ok: false, errorCode: 'models.invalidBaseUrl', status: null, detail: null };
  }
  const { headers } = buildCatalogRequest(input.baseUrl, input.api, input.apiKey);
  const origin = target.origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8000);

  try {
    let response: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await fetchImpl(target.toString(), { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, target);
      if (next.origin !== origin) {
        return { ok: false, errorCode: 'models.redirectBlocked', status: response.status, detail: next.origin };
      }
      if (hop === MAX_REDIRECTS) return { ok: false, errorCode: 'models.tooManyRedirects', status: response.status, detail: null };
      target = next;
    }
    if (!response) return { ok: false, errorCode: 'models.testFailed', status: null, detail: null };

    if (response.status === 404 || response.status === 405) {
      return { ok: true, catalogUnavailable: true, models: [], status: response.status };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, errorCode: 'models.authFailed', status: response.status, detail: null };
    }
    const body = await readCapped(response);
    if (body === null) return { ok: false, errorCode: 'models.catalogTooLarge', status: response.status, detail: null };
    if (!response.ok) {
      return { ok: false, errorCode: 'models.testFailed', status: response.status, detail: body.slice(0, 200) };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, errorCode: 'models.catalogNotJson', status: response.status, detail: null };
    }
    const models = extractModelIds(payload);
    if (models.length > MAX_MODELS) return { ok: false, errorCode: 'models.catalogTooLarge', status: response.status, detail: null };
    return { ok: true, catalogUnavailable: false, models, status: response.status };
  } catch (error) {
    const aborted = (error as { name?: string })?.name === 'AbortError';
    return { ok: false, errorCode: aborted ? 'models.testTimeout' : 'models.unreachable', status: null, detail: null };
  } finally {
    clearTimeout(timer);
  }
}
