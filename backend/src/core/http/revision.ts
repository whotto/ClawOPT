/**
 * 配置编辑器的版本号（乐观锁）。
 *
 * 两个浏览器标签页同时打开同一个设置页，各改一处先后保存：没有版本号时，后保存的那份
 * 整体覆盖先保存的——文件是完整的，改动却少了一次。版本号让第二次保存拿到 412 和
 * 当前状态，由界面决定是合并还是重来。
 *
 * ## 为什么哈希里**包含密钥值**
 *
 * 界面上看不到 apiKey 的值（凭据只出不进），但「有人在另一个标签页换了 apiKey」
 * 同样是并发修改。哈希只算公开字段的话，这种冲突会被判成「没变」，
 * 后保存的那份就把新密钥覆盖回旧的。所以版本号对**完整内容**求值；
 * 它是 SHA-256 摘要，不可逆，回给前端不泄露密钥。
 *
 * 412 响应里的 `current` 由调用方给**已脱敏的视图**——这里只负责比对和回话，
 * 不替调用方决定哪些字段能出去。
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';

export const REVISION_CONFLICT_ERROR_CODE = 'REVISION_CONFLICT';
export const REVISION_REQUIRED_ERROR_CODE = 'REVISION_REQUIRED';

/** 规范化 JSON：对象键递归排序，数组保序，`undefined` 字段与 JSON.stringify 一样丢弃。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function computeRevision(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * 读客户端声明的版本：`If-Match` 头优先（去掉 `W/` 与引号），其次请求体的 `revision`。
 * 都没有返回 null。
 */
export function readRequestedRevision(req: Pick<Request, 'header' | 'body'>): string | null {
  const header = req.header('if-match');
  if (typeof header === 'string' && header.trim()) {
    const first = header.split(',')[0].trim().replace(/^W\//, '');
    return first.replace(/^"(.*)"$/, '$1') || null;
  }
  const bodyRevision = (req.body as Record<string, unknown> | undefined)?.revision;
  return typeof bodyRevision === 'string' && bodyRevision.trim() ? bodyRevision.trim() : null;
}

export type RevisionCheckInput = {
  /** 参与哈希的完整当前值（含密钥）。 */
  value: unknown;
  /** 412 时回给客户端的当前状态（调用方负责脱敏）。 */
  view: unknown;
  /** 没带版本号时是否拒绝（428）。默认放行，老客户端不受影响。 */
  required?: boolean;
};

/**
 * 校验请求带来的版本号。通过返回 `true`（调用方继续写入）；
 * 不通过时已经写好响应并返回 `false`：
 * - 版本不符 → 412 `{ errorCode: 'REVISION_CONFLICT', current: { revision, value } }`
 * - `required` 且没带版本 → 428 `{ errorCode: 'REVISION_REQUIRED', current: ... }`
 */
export function enforceRevision(req: Pick<Request, 'header' | 'body'>, res: Response, input: RevisionCheckInput): boolean {
  const currentRevision = computeRevision(input.value);
  const requested = readRequestedRevision(req);
  const current = { revision: currentRevision, value: input.view };

  if (requested === null) {
    if (!input.required) return true;
    res.status(428).json({
      success: false,
      errorCode: REVISION_REQUIRED_ERROR_CODE,
      errorParams: null,
      errorDetail: null,
      current,
    });
    return false;
  }

  if (requested !== currentRevision) {
    res.status(412).json({
      success: false,
      errorCode: REVISION_CONFLICT_ERROR_CODE,
      errorParams: null,
      errorDetail: null,
      current,
    });
    return false;
  }

  return true;
}
