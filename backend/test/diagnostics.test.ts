/**
 * 诊断快照 —— v1.6.0。
 *
 * ## 它要解决的问题
 *
 * 这个产品装在用户自己的 Linux 主机上，我们看不见。CHANGELOG 里几乎每条修复都写着
 * 「生产实测」「真机上才看得见」，而排障靠的是让用户截个图、或者要到 SSH。
 * 一份能一键复制的快照，抵得上好几轮来回。
 *
 * ## 判据
 *
 * 1. **读不到 ≠ 没有。** 引擎版本探不到要如实说 unknown 并带上原因，不能塞一个
 *    具体版本进去——这条在 `openclaw-version.ts` 上已经栽过一次，判据不能在
 *    汇总层被稀释回去。
 * 2. **任何一块采集失败都不能让整份报告 500。** 排障工具在故障现场崩掉，
 *    等于没有。这跟 v1.2.4「只读接口在配置读不动时不再整体 500」是同一条。
 * 3. **整份报告必须过脱敏。** 它从 HTTP 出去，且里面天然带工作区绝对路径
 *    （含用户名）与引擎配置摘要。v1.2.3 修过「报错把凭据带进响应体」，
 *    这里不能换个出口重开。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import { buildDiagnosticsReport } from '../src/control/diagnostics/diagnostics';
import { createLogger, resetLogBufferForTests } from '../src/core/logger/logger';

const deps = (over: Partial<Parameters<typeof buildDiagnosticsReport>[0]> = {}) => ({
  checkInvariants: () => [] as any[],
  readConfig: () => ({ agents: { list: [{ id: 'main' }, { id: 'biz' }] } }) as Record<string, unknown>,
  detectEngineVersion: () => ({ known: true as const, raw: '2026.7.1-2', year: 2026, month: 7, patch: 1 }),
  gatewayStatus: () => ({ connected: true, endpoint: 'ws://127.0.0.1:18789' }),
  browserHealth: () => ({ state: 'ready' as const }),
  ...over,
});

beforeEach(() => resetLogBufferForTests());

describe('汇总', () => {
  it('带上版本、引擎版本、名册形状与条目数', () => {
    const report = buildDiagnosticsReport(deps());

    expect(report.app.version, '应用版本缺失').toBeTruthy();
    expect(report.engine.version).toBe('2026.7.1-2');
    expect(report.roster.shape).toBe('list');
    expect(report.roster.count).toBe(2);
  });

  it('带上运行环境：node 版本、平台、数据目录', () => {
    const report = buildDiagnosticsReport(deps());
    expect(report.runtime.node).toBe(process.version);
    expect(report.runtime.platform).toBe(process.platform);
  });

  it('带上最近的日志，且是脱敏之后的', () => {
    createLogger('Models').warn('刷新失败', { apiKey: 'sk-live-abcdefghijklmnop' });
    const report = buildDiagnosticsReport(deps());

    expect(report.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(report), '诊断报告把凭据带出去了').not.toContain('sk-live-abcdefghijklmnop');
  });

  it('工作区绝对路径里的用户名被换成 ~', () => {
    const home = os.homedir();
    const report = buildDiagnosticsReport(deps({
      readConfig: () => ({ agents: { list: [{ id: 'main', workspace: `${home}/.openclaw/workspace-main` }] } }),
    }));
    expect(JSON.stringify(report)).not.toContain(home);
  });
});

describe('读不到 ≠ 没有', () => {
  it('引擎探不到时如实报 unknown 并带原因，**不塞一个具体版本**', () => {
    const report = buildDiagnosticsReport(deps({
      detectEngineVersion: () => ({ known: false as const, reason: 'notInstalled' }),
    }));
    expect(report.engine.version).toBeNull();
    expect(report.engine.reason).toBe('notInstalled');
  });

  it('配置读不动时标记出来，而不是报告一个「0 个 Agent」的假象', () => {
    const report = buildDiagnosticsReport(deps({
      readConfig: () => { throw new Error('boom'); },
    }));
    expect(report.roster.configReadFailed, '配置读失败被当成了「没有 Agent」').toBe(true);
    expect(report.roster.count).toBeNull();
  });
});

describe('任何一块失败都不能让整份报告塌掉', () => {
  it('网关探测抛错时，其余部分照常产出', () => {
    const report = buildDiagnosticsReport(deps({
      gatewayStatus: () => { throw new Error('gateway down'); },
    }));
    expect(report.gateway.available).toBe(false);
    expect(report.app.version, '一块失败把整份报告拖垮了').toBeTruthy();
    expect(report.roster.count).toBe(2);
  });

  it('全部依赖都抛错时仍返回一份可解析的报告', () => {
    const boom = () => { throw new Error('boom'); };
    expect(() => buildDiagnosticsReport({
      readConfig: boom, detectEngineVersion: boom, gatewayStatus: boom, browserHealth: boom,
    } as any)).not.toThrow();
  });

  it('报错细节不带原始 message——它可能嵌着输入原文', () => {
    const report = buildDiagnosticsReport(deps({
      readConfig: () => { throw new SyntaxError('Unexpected token in {"apiKey":"sk-LEAK"}'); },
    }));
    expect(JSON.stringify(report)).not.toContain('sk-LEAK');
  });
});

describe('运行时不变量并进报告', () => {
  it('告警出现在报告里，排障时一眼看到「这台机器哪里坏了」', () => {
    const report = buildDiagnosticsReport(deps({
      checkInvariants: () => [
        { code: 'memberLockStale', severity: 'warning', message: '成员 a1 的运行锁已持有 20 分钟' },
      ],
    }));
    expect(report.invariants).toHaveLength(1);
    expect(report.invariants[0].code).toBe('memberLockStale');
  });

  it('不变量检查自己抛错时，**报成「检查器崩了」而不是空数组**', () => {
    // 这是不变量系统的经典失效模式：诊断本身有单点故障，且故障时静默降级为空。
    // 空数组和「一切正常」在界面上无法区分——那正是 v1.5.0 冒名 DeepSeek 的同族形状：
    // 状态看起来是对的，实际不能用。
    const report = buildDiagnosticsReport(deps({
      checkInvariants: () => { throw new Error('boom'); },
    }));
    expect(report.app.version, '一块失败把整份报告拖垮了').toBeTruthy();
    expect(report.invariants, '检查器崩了却显示成「没有问题」').toHaveLength(1);
    expect(report.invariants[0].code).toBe('invariantsCheckerCrashed');
    expect(report.invariants[0].severity).toBe('critical');
  });

  it('检查器崩溃的细节不带原始 message', () => {
    const report = buildDiagnosticsReport(deps({
      checkInvariants: () => { throw new SyntaxError('boom {"apiKey":"sk-LEAK"}'); },
    }));
    expect(JSON.stringify(report)).not.toContain('sk-LEAK');
  });

  it('告警里的绝对路径同样过脱敏', () => {
    const home = os.homedir();
    const report = buildDiagnosticsReport(deps({
      checkInvariants: () => [
        { code: 'externalMemberWorkdirMissing', severity: 'critical', message: 'x',
          details: { workingDir: `${home}/projects/app` } },
      ],
    }));
    expect(JSON.stringify(report)).not.toContain(home);
  });
});

