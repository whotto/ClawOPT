/**
 * 可用运行时清单 —— 界面要据此决定「能不能选 claude-code」。
 *
 * 判据只实现一次：二进制探测复用 `runtime-invariants` 那条路径上同一个
 * `binaryExists`（沿 PATH 找文件，不 shell out——起进程的成败取决于谁的 PATH 在前，
 * 而我们只问「文件在不在」，`openclaw-version.ts` 当初就是为这个不 shell out 的）。
 *
 * `probedAt` 这一格是刻意留的：外部 CLI 会自己升级，一次探测的结果有半衰期。
 * 界面可以据此显示「检测于 X 分钟前」并提供重新检测，而不是把一个可能过期的
 * 结论当成事实摆着。
 */
import { describe, it, expect } from 'vitest';
import { buildExternalRuntimeList, EXTERNAL_RUNTIMES } from '../src/runtime/external-agents/registry';

describe('清单形状', () => {
  it('每个运行时都给出 id、二进制名与可用性', () => {
    const list = buildExternalRuntimeList(() => true);
    expect(list.length).toBe(EXTERNAL_RUNTIMES.length);
    for (const entry of list) {
      expect(entry.id).toBeTruthy();
      expect(entry.binary).toBeTruthy();
      expect(typeof entry.available).toBe('boolean');
    }
  });

  it('**带 probedAt**——探测结果有半衰期，界面要能说出「检测于几分钟前」', () => {
    const list = buildExternalRuntimeList(() => true);
    expect(Number.isNaN(Date.parse(list[0].probedAt)), 'probedAt 不是可解析的时间戳').toBe(false);
  });

  it('按主机实况分可用与不可用，不是一律 true', () => {
    const list = buildExternalRuntimeList((binary) => binary === 'claude');
    const byId = Object.fromEntries(list.map((e) => [e.id, e]));
    expect(byId['claude-code'].available).toBe(true);
    expect(byId['codex'].available).toBe(false);
  });

  it('探测器抛错时判为不可用，而不是让整份清单塌掉', () => {
    // 某个 PATH 目录不可读不该让「有哪些运行时」这个问题变成 500。
    const list = buildExternalRuntimeList(() => { throw new Error('boom'); });
    expect(list.every((e) => e.available === false)).toBe(true);
  });

  it('claude-code 一定在清单里——它是目前唯一真机验过的那个', () => {
    expect(EXTERNAL_RUNTIMES.map((r) => r.id)).toContain('claude-code');
  });

  it('每个运行时都有中文可读的名字，界面不必自己拼', () => {
    for (const r of EXTERNAL_RUNTIMES) expect(r.label.length).toBeGreaterThan(0);
  });
});

describe('与适配器的对应关系', () => {
  it('清单里的 id 与 group_members.runtime 用的是同一套取值', () => {
    // 两套取值迟早分家：界面写 'claude_code'、库里存 'claude-code'，
    // 而分家的症状是「选了但不生效」——本仓库为这个形状栽过（v1.3.0）。
    expect(EXTERNAL_RUNTIMES.map((r) => r.id)).toContain('claude-code');
    expect(EXTERNAL_RUNTIMES.every((r) => /^[a-z][a-z0-9-]*$/.test(r.id))).toBe(true);
  });
});
