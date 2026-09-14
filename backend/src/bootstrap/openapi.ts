/**
 * `backend/openapi.json` 的内容。生成脚本与漂移测试共用这一个函数，
 * 这样「签入的文档是不是最新的」可以在 `npm test` 里机械地判。
 */
import { AUTH_COOKIE_NAME } from '../core/auth';
import { buildOpenApiDocument } from '../core/http';
import { collectRouteRecords } from './route-inventory';

/**
 * 文档自身的版本，不跟应用版本走——跟着走的话每次发版都得重新生成一遍，
 * 漂移测试会在一个与接口无关的改动上报红。接口形状变了才改这里。
 */
export const OPENAPI_DOCUMENT_VERSION = '1.0.0';

export function renderOpenApiJson(): string {
  const document = buildOpenApiDocument(collectRouteRecords(), {
    version: OPENAPI_DOCUMENT_VERSION,
    cookieName: AUTH_COOKIE_NAME,
  });
  return `${JSON.stringify(document, null, 2)}\n`;
}
