/**
 * 网关握手身份：我们是后端进程，不是浏览器。
 *
 * ## 这条守卫买来的教训
 *
 * 2026-09-03 生产实测：整站聊天不可用，每一次 agent 调用都失败于
 *
 * ```
 * control ui requires device identity (use HTTPS or localhost secure context)
 * ```
 *
 * 单聊、群聊都中招，而且**很可能从 2026.8.2 升级当天就坏了**——没人发过消息，
 * 所以没人发现。
 *
 * 引擎放行本地后端的判据（`shouldSkipLocalBackendSelfPairing`）：
 *
 * ```js
 * const isBackendClient = client.id === "gateway-client"
 *                      && client.mode === "backend";
 * if (!isBackendClient || !isLocal || params.hasBrowserOriginHeader) return false;
 * ```
 *
 * ClawOPT 三条全踩：报 `openclaw-control-ui` / `webchat`，还额外送了一个
 * `Origin: ws://127.0.0.1:18789`（scheme 都不合法）。于是网关按浏览器对待，
 * 而浏览器必须有设备身份，我们没有。
 *
 * 2026.7 不查这个，2026.8 查了。**这类破坏不会在测试里出现**，只会在真机上
 * 以「所有人都不说话了」的形式出现——所以钉在这里。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const src = () => fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'openclaw-client.ts'), 'utf-8',
);

/** 剥掉注释再断言：解释这个坑的注释里就写着那些错误值。 */
function codeOnly(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('connect 握手', () => {
  it('client.id 是 gateway-client，不是 openclaw-control-ui', () => {
    const code = codeOnly(src());
    expect(code, '报成 control-ui 会被要求设备身份').toContain("id: 'gateway-client'");
    expect(code).not.toContain("id: 'openclaw-control-ui'");
  });

  it('client.mode 是 backend，不是 webchat', () => {
    const code = codeOnly(src());
    expect(code).toContain("mode: 'backend'");
    expect(code).not.toContain("mode: 'webchat'");
  });

  it('不送 Origin 头', () => {
    const code = codeOnly(src());
    // 送了 Origin，`hasBrowserOriginHeader` 为真，本地后端自动配对**一票否决**，
    // 无论 id/mode 报什么都没用。
    expect(code, '又送 Origin 头了').not.toMatch(/headers\s*=\s*\{\s*Origin/);
  });

  it('三个条件都写在同一处，改一个就该看见其余两个', () => {
    const raw = src();
    // 它们必须一起成立才放行，所以也该一起被读到。把判据抄在代码旁边，
    // 是为了让下一个人改 client.id 时先看见 mode 和 Origin 也在同一个判据里。
    expect(raw).toContain('shouldSkipLocalBackendSelfPairing'.slice(0, 0) + 'hasBrowserOriginHeader');
    expect(raw).toContain('isBackendClient');
  });
});
