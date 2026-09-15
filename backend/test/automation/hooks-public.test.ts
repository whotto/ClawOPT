/**
 * 入站钩子是公开路由：鉴权白名单的模式匹配、HMAC 签名、时间窗、防重放、停用即 404。
 * 这些是安全守卫——每一条都在报告里记录了「改坏它会红」的验证。
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/bootstrap';
import { createAuthMiddleware, isAuthPublicPath } from '../../src/core/auth';
import { createInboundHooks, signHookBody, signaturesMatch } from '../../src/automation/hooks/inbound-hooks';
import { createStubContext } from '../helpers/stub-context';
import { node, setupEngine } from './helpers';

describe('isAuthPublicPath：参数段只匹配恰好一个非空段', () => {
  it.each([
    ['/api/hooks/workflows/abc', true],
    ['/api/hooks/webhook-test/tok', true],
    ['/api/auth/login', true],
    ['/api/hooks/workflows/', false],
    ['/api/hooks/workflows', false],
    ['/api/hooks/workflows/abc/extra', false],
    ['/api/hooks/workflowsX/abc', false],
    ['/api/workflows/abc', false],
    ['/api/hooks/other/abc', false],
  ])('%s → %s', (requestPath, expected) => {
    expect(isAuthPublicPath(requestPath)).toBe(expected);
  });
});

function signedRequest(secret: string, body: unknown, options: { timestamp?: number; tamper?: boolean } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  let signature = signHookBody(secret, timestamp, raw);
  if (options.tamper) signature = signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  return { rawBody: raw, body, timestamp, signature };
}

describe('入站钩子校验', () => {
  function setup() {
    const t = setupEngine();
    const hooks = createInboundHooks({ db: t.db, defs: t.defs, engine: t.engine });
    const def = t.create([node('a')]);
    const { hook, secret } = hooks.create(def.id, { name: 'ci' });
    return { t, hooks, def, hook, secret };
  }

  it('签名正确、时间在窗内 → 触发运行，负载成为运行输入', async () => {
    const { t, hooks, hook, secret } = setup();
    const result = await hooks.trigger(hook.id, signedRequest(secret, { input: 'from ci' }));
    await t.engine.waitForRun(result.runId);
    expect(t.runStore.getRun(result.runId)).toMatchObject({ status: 'completed', triggerSource: 'hook', input: 'from ci' });
  });

  it('非 input 形状的负载整体作为 JSON 文本输入', async () => {
    const { t, hooks, hook, secret } = setup();
    const result = await hooks.trigger(hook.id, signedRequest(secret, { ref: 'main', sha: 'abc' }));
    await t.engine.waitForRun(result.runId);
    expect(t.runStore.getRun(result.runId)!.input).toBe('{"ref":"main","sha":"abc"}');
  });

  it('签名不对 → 401，不启动运行', async () => {
    const { t, hooks, hook, secret, def } = setup();
    await expect(hooks.trigger(hook.id, signedRequest(secret, { input: 'x' }, { tamper: true }))).rejects.toMatchObject({ status: 401, code: 'hooks.signatureInvalid' });
    expect(t.runStore.listRuns(def.id, 5)).toEqual([]);
  });

  it('请求体被改过（签名对应的是原始字节）→ 401', async () => {
    const { hooks, hook, secret } = setup();
    const request = signedRequest(secret, { input: 'x' });
    await expect(hooks.trigger(hook.id, { ...request, rawBody: Buffer.from('{"input":"y"}') })).rejects.toMatchObject({ status: 401 });
  });

  it('时间戳超出 ±5 分钟 → 401；缺时间戳 → 401', async () => {
    const { hooks, hook, secret } = setup();
    const old = Math.floor(Date.now() / 1000) - 301;
    await expect(hooks.trigger(hook.id, signedRequest(secret, { input: 'x' }, { timestamp: old }))).rejects.toMatchObject({ status: 401, code: 'hooks.timestampOutOfWindow' });
    const future = Math.floor(Date.now() / 1000) + 301;
    await expect(hooks.trigger(hook.id, signedRequest(secret, { input: 'x' }, { timestamp: future }))).rejects.toMatchObject({ status: 401 });
    await expect(hooks.trigger(hook.id, { ...signedRequest(secret, {}), timestamp: undefined })).rejects.toMatchObject({ status: 401 });
  });

  it('同一签名重放 → 409（即使仍在时间窗内）', async () => {
    const { t, hooks, hook, secret } = setup();
    const request = signedRequest(secret, { input: 'once' });
    const first = await hooks.trigger(hook.id, request);
    await t.engine.waitForRun(first.runId);
    await expect(hooks.trigger(hook.id, request)).rejects.toMatchObject({ status: 409, code: 'hooks.replayed' });
  });

  it('停用与不存在返回同一个 404', async () => {
    const { hooks, hook, secret, def } = setup();
    hooks.update(def.id, hook.id, { enabled: false });
    await expect(hooks.trigger(hook.id, signedRequest(secret, {}))).rejects.toMatchObject({ status: 404, code: 'hooks.notFound' });
    await expect(hooks.trigger('nope', signedRequest(secret, {}))).rejects.toMatchObject({ status: 404, code: 'hooks.notFound' });
  });

  it('轮换密钥后旧密钥签名失效；列表只报 hasSecret', async () => {
    const { hooks, hook, secret, def } = setup();
    const rotated = hooks.rotateSecret(def.id, hook.id);
    expect(rotated.secret).not.toBe(secret);
    await expect(hooks.trigger(hook.id, signedRequest(secret, {}))).rejects.toMatchObject({ status: 401 });
    expect(hooks.list(def.id)[0]).toMatchObject({ hasSecret: true });
    expect(JSON.stringify(hooks.list(def.id))).not.toContain(rotated.secret);
  });

  it('签名比较：长度不同直接不等，不抛', () => {
    expect(signaturesMatch('sha256=aa', 'sha256=a')).toBe(false);
    expect(signaturesMatch('sha256=aa', 'sha256=aa')).toBe(true);
  });
});

describe('HTTP：登录开启时，钩子入口越过闸门由处理器自己判定', () => {
  let server: http.Server;
  let baseUrl = '';
  let hookId = '';
  let secret = '';

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = setupEngine();
    const hooks = createInboundHooks({ db: t.db, defs: t.defs, engine: t.engine });
    const def = t.create([node('a')]);
    ({ hook: { id: hookId }, secret } = hooks.create(def.id, {}));
    const configManager = { getConfig: () => ({ loginEnabled: true, allowedHosts: [] }) };
    // 与 P5a 之后的鉴权门面对齐：会话令牌解析不到 → 未登录；还没有任何用户。
    const authStore = { resolve: () => null, verify: () => false };
    const userStore = { count: () => 0, get: () => null, firstActiveSuperAdmin: () => null, hasAgent: () => false };
    const auth = createAuthMiddleware({ configManager, authStore, userStore } as any);
    const automation = { hooks, webhooks: { receiveTest: () => false } };
    const built = buildApp(createStubContext({ configManager, authStore, userStore, auth, automation }));
    server = http.createServer(built.app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('未签名请求：处理器回 401 hooks.*（不是登录闸门的 auth.loginRequired）', async () => {
    const response = await fetch(`${baseUrl}/api/hooks/workflows/${hookId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
    expect((await response.json()).errorCode).toBe('hooks.timestampOutOfWindow');
  });

  it('正确签名（按原始字节）→ 202', async () => {
    const raw = '{"input":"over http"}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${baseUrl}/api/hooks/workflows/${hookId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ClawOPT-Timestamp': timestamp, 'X-ClawOPT-Signature-256': signHookBody(secret, timestamp, raw) },
      body: raw,
    });
    expect(response.status).toBe(202);
    expect((await response.json()).runId).toBeTruthy();
  });

  it('近似路径不在白名单：登录闸门回 401 auth.loginRequired', async () => {
    const response = await fetch(`${baseUrl}/api/hooks/workflows/${hookId}/extra`, { method: 'POST' });
    expect(response.status).toBe(401);
    expect((await response.json()).errorCode).toBe('auth.loginRequired');
  });

  it('工作流管理接口仍受保护', async () => {
    const response = await fetch(`${baseUrl}/api/workflows`);
    expect(response.status).toBe(401);
  });

  it('本机测试收件箱：拒绝时统一 404', async () => {
    const response = await fetch(`${baseUrl}/api/hooks/webhook-test/whatever`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(404);
  });
});
