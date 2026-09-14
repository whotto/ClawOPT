/**
 * 运行时不变量 —— 借鉴 HKUDS/OpenOPC 的 `work_item_runtime_invariants.py`。
 *
 * ## 为什么值得单独做一层
 *
 * 我们的守卫全在测试里：CI 绿了就完事。但这个产品装在用户自己的主机上，
 * 出事的形态是「某台机器上的某个状态坏了」，而不是「代码写错了」——
 * CI 再绿也照不到那里。OpenOPC 把一部分判据放到**运行时**持续校验并上报，
 * 这个思路和我们刚做的 `/api/diagnostics` 是同一条线。
 *
 * ## 挑哪几条，是有依据的
 *
 * 不照搬它的工作项那套（我们没有工作项）。这里每一条都对应本仓库历史上真出过、
 * 且**今天完全看不见**的一类故障：
 *
 * - 成员锁泄漏 → 外部进程跑飞，那个成员要等 15 分钟才能再说话
 * - 孤儿外部会话 → v1.2.5 那类「手写级联漏了一行」
 * - 名册两种形状并存 → 迁移到一半，`agents-roster` 早就能测出来，但没人消费
 * - 声明了 CLI 后端却没有二进制 → 2026-09-12 在生产机上实测到的现状
 * - 外部成员配置不可用 → 界面显示得像配好了，一 @ 就失败
 *
 * 最后一条尤其是这个仓库反复出现的形状：**状态看起来是对的，实际不能用**。
 */
import { describe, it, expect } from 'vitest';
import { checkRuntimeInvariants } from '../src/runtime/runtime-invariants';

const healthy = () => ({
  readConfig: () => ({ agents: { list: [{ id: 'main' }] } }) as Record<string, unknown>,
  listGroupMembers: () => [
    { id: 'm1', group_id: 'g1', agent_id: 'main', display_name: '管家', runtime: 'openclaw', external_config: null },
  ],
  listExternalSessions: () => [] as any[],
  heldMemberLocks: () => [] as any[],
  binaryExists: () => true,
  pathExists: () => true,
});

const codes = (issues: any[]) => issues.map((i) => i.code).sort();

describe('健康系统不产出噪音', () => {
  it('一切正常时没有任何告警', () => {
    expect(checkRuntimeInvariants(healthy())).toEqual([]);
  });
});

describe('成员锁泄漏', () => {
  it('持锁超过陈旧阈值时报出来', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      heldMemberLocks: () => [{ groupId: 'g1', agentId: 'a1', heldMs: 20 * 60 * 1000 }],
    });
    expect(codes(issues)).toContain('memberLockStale');
    expect(issues[0].details.agentId).toBe('a1');
  });

  it('正常时长的持锁不报——外部 Agent 跑几分钟是常态', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      heldMemberLocks: () => [{ groupId: 'g1', agentId: 'a1', heldMs: 3 * 60 * 1000 }],
    });
    expect(issues).toEqual([]);
  });
});

describe('孤儿外部会话', () => {
  it('会话指向已经不存在的成员时报出来', () => {
    // 这个库的级联是手写的，漏补一行不会报错，只会让孤儿行越积越多。
    const issues = checkRuntimeInvariants({
      ...healthy(),
      listExternalSessions: () => [
        { group_id: 'g1', member_id: '已删除的成员', session_id: 'x', status: 'ok', last_error: null },
      ],
    });
    expect(codes(issues)).toContain('externalSessionOrphan');
  });
});

describe('名册两种形状并存', () => {
  it('list 与 entries 同时存在 = 迁移到一半', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      readConfig: () => ({ agents: { list: [{ id: 'a' }], entries: { b: {} } } }),
    });
    expect(codes(issues)).toContain('rosterBothShapes');
  });
});

describe('声明了 CLI 后端却没有二进制', () => {
  it('配置里引用 claude-cli 而主机上没有 claude 时报出来', () => {
    // 2026-09-12 生产机实测：openclaw.json 声明了 claude-cli / gemini-cli，
    // 而全局 node_modules 里一个都没有。今天谁选中就踩空，且毫无提示。
    const issues = checkRuntimeInvariants({
      ...healthy(),
      readConfig: () => ({
        agents: { list: [{ id: 'main', model: 'claude-cli/claude-sonnet-5' }] },
      }),
      binaryExists: (name: string) => name !== 'claude',
    });
    expect(codes(issues)).toContain('cliBackendBinaryMissing');
    expect(issues[0].details.binary).toBe('claude');
  });

  it('二进制在就不报', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      readConfig: () => ({ agents: { list: [{ id: 'main', model: 'claude-cli/claude-sonnet-5' }] } }),
    });
    expect(issues).toEqual([]);
  });
});

describe('外部成员配置不可用（界面像配好了，一 @ 就失败）', () => {
  const externalMember = (over: Record<string, unknown> = {}) => ({
    ...healthy(),
    listGroupMembers: () => [{
      id: 'm1', group_id: 'g1', agent_id: 'eng', display_name: 'Eng',
      runtime: 'claude-code',
      external_config: JSON.stringify({ workingDir: '/srv/app' }),
      ...over,
    }],
  });

  it('完全没有配置', () => {
    expect(codes(checkRuntimeInvariants(externalMember({ external_config: null }))))
      .toContain('externalMemberConfigMissing');
  });

  it('配置是坏 JSON', () => {
    expect(codes(checkRuntimeInvariants(externalMember({ external_config: '{坏掉的' }))))
      .toContain('externalMemberConfigUnparsable');
  });

  it('工作目录不存在', () => {
    const issues = checkRuntimeInvariants({ ...externalMember(), pathExists: () => false });
    expect(codes(issues)).toContain('externalMemberWorkdirMissing');
  });

  it('运行时对应的二进制不在', () => {
    const issues = checkRuntimeInvariants({ ...externalMember(), binaryExists: () => false });
    expect(codes(issues)).toContain('externalMemberBinaryMissing');
  });

  it('配置齐全时不报', () => {
    expect(checkRuntimeInvariants(externalMember())).toEqual([]);
  });
});

describe('不可续会话堆积', () => {
  it('同一成员连续多次失败时报出来——说明有系统性问题', () => {
    const sessions = Array.from({ length: 3 }, (_, i) => ({
      group_id: 'g1', member_id: 'm1', session_id: `s${i}`, status: 'failed', last_error: 'exit 1',
    }));
    const issues = checkRuntimeInvariants({ ...healthy(), listExternalSessions: () => sessions });
    expect(codes(issues)).toContain('externalSessionsUnusable');
  });
});

describe('一条检查塌掉不牵连其余', () => {
  it('某个依赖抛错时，其余检查照常产出', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      readConfig: () => { throw new Error('boom'); },
      heldMemberLocks: () => [{ groupId: 'g1', agentId: 'a1', heldMs: 20 * 60 * 1000 }],
    });
    // 排障工具在故障现场崩掉等于没有——这条和 diagnostics 是同一条纪律。
    expect(codes(issues)).toContain('memberLockStale');
    expect(codes(issues)).toContain('invariantCheckFailed');
  });

  it('报错细节不带原始 message——它可能嵌着输入原文', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      readConfig: () => { throw new SyntaxError('Unexpected token in {"apiKey":"sk-LEAK"}'); },
    });
    expect(JSON.stringify(issues)).not.toContain('sk-LEAK');
  });
});

describe('告警形状', () => {
  it('每条都带 code、severity 与可读信息', () => {
    const issues = checkRuntimeInvariants({
      ...healthy(),
      heldMemberLocks: () => [{ groupId: 'g1', agentId: 'a1', heldMs: 20 * 60 * 1000 }],
    });
    expect(issues[0]).toMatchObject({
      code: 'memberLockStale',
      severity: expect.stringMatching(/^(warning|critical)$/),
    });
    expect(String(issues[0].message).length).toBeGreaterThan(0);
  });
});
