/**
 * 配置版本号：规范化哈希（含密钥）+ If-Match / body.revision → 412。
 * 只测助手本身，现有编辑器 P0 不接。
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  computeRevision,
  enforceRevision,
  readRequestedRevision,
} from '../src/core/http/revision';

function fakeReq(headers: Record<string, string> = {}, body: unknown = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    body,
  } as any;
}

function fakeRes() {
  const res: any = { statusCode: 200, payload: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.payload = payload; return res; };
  return res;
}

describe('computeRevision', () => {
  it('键顺序不影响版本号，数组顺序影响', () => {
    expect(computeRevision({ a: 1, b: { c: 2, d: 3 } })).toBe(computeRevision({ b: { d: 3, c: 2 }, a: 1 }));
    expect(computeRevision({ list: [1, 2] })).not.toBe(computeRevision({ list: [2, 1] }));
  });

  it('只改密钥值，版本号也变（界面看不见的并发修改同样算冲突）', () => {
    const before = { models: { providers: { openai: { apiKey: 'sk-old', baseUrl: 'x' } } } };
    const after = { models: { providers: { openai: { apiKey: 'sk-new', baseUrl: 'x' } } } };
    expect(computeRevision(before)).not.toBe(computeRevision(after));
  });

  it('undefined 字段与缺省等价（与 JSON 落盘后的形状一致）', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(computeRevision({ a: 1, b: undefined })).toBe(computeRevision({ a: 1 }));
  });

  it('是 64 位十六进制 SHA-256，且不包含原文', () => {
    const revision = computeRevision({ apiKey: 'sk-secret' });
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    expect(revision).not.toContain('secret');
  });
});

describe('readRequestedRevision', () => {
  it('If-Match 优先，去掉 W/ 与引号', () => {
    expect(readRequestedRevision(fakeReq({ 'if-match': 'W/"abc"' }, { revision: 'body' }))).toBe('abc');
    expect(readRequestedRevision(fakeReq({ 'if-match': '"abc", "def"' }))).toBe('abc');
  });

  it('没有头时读 body.revision；都没有返回 null', () => {
    expect(readRequestedRevision(fakeReq({}, { revision: ' r1 ' }))).toBe('r1');
    expect(readRequestedRevision(fakeReq({}, {}))).toBeNull();
    expect(readRequestedRevision(fakeReq({}, undefined))).toBeNull();
  });
});

describe('enforceRevision', () => {
  const value = { gateway: { token: 'secret-token' }, name: 'A' };
  const view = { gateway: { hasToken: true }, name: 'A' };

  it('版本匹配放行，不写响应', () => {
    const res = fakeRes();
    expect(enforceRevision(fakeReq({ 'if-match': `"${computeRevision(value)}"` }), res, { value, view })).toBe(true);
    expect(res.payload).toBeUndefined();
  });

  it('版本不符 → 412 REVISION_CONFLICT，带当前版本与调用方给的脱敏视图', () => {
    const res = fakeRes();
    expect(enforceRevision(fakeReq({}, { revision: 'stale' }), res, { value, view })).toBe(false);
    expect(res.statusCode).toBe(412);
    expect(res.payload).toEqual({
      success: false,
      errorCode: 'REVISION_CONFLICT',
      errorParams: null,
      errorDetail: null,
      current: { revision: computeRevision(value), value: view },
    });
    expect(JSON.stringify(res.payload)).not.toContain('secret-token');
  });

  it('没带版本号：默认放行；required 时 428', () => {
    expect(enforceRevision(fakeReq(), fakeRes(), { value, view })).toBe(true);
    const res = fakeRes();
    expect(enforceRevision(fakeReq(), res, { value, view, required: true })).toBe(false);
    expect(res.statusCode).toBe(428);
    expect(res.payload.errorCode).toBe('REVISION_REQUIRED');
  });
});
