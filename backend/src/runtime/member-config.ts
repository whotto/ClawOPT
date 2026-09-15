/**
 * 群成员 `external_config` 的写入清洗。
 *
 * `GET /api/groups` 会把成员行原样回给前端，所以这个字段里**不能有凭据**：远程 OpenClaw 的令牌
 * 走专门的只写接口进加密存储。这里把误塞进来的凭据类键剥掉——凭据只进不出，塞错地方也不许回显。
 *
 * - `undefined` / `null` → `null`（「不改」，由 saveGroupMember 的 COALESCE 保持原值）；
 * - 字符串按 JSON 解析，对象直接用；解析不了的字符串原样保留（老数据，不因为清洗而丢失）。
 */
const CREDENTIAL_KEY = /^(token|password|apiKey|api_key|secret|authorization|gatewayToken)$/i;

export function sanitizeMemberExternalConfig(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return typeof value === 'string' ? value : null;
  const clean = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([key]) => !CREDENTIAL_KEY.test(key)));
  return JSON.stringify(clean);
}
