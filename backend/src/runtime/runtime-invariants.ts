/**
 * 运行时不变量：把「某台机器上的状态坏了」变成看得见的东西。
 *
 * 我们的守卫全在测试里——CI 绿了就完事。但这个产品装在用户自己的主机上，
 * 出事的形态是「某台机器上的某个状态坏了」，而不是「代码写错了」，CI 再绿也
 * 照不到那里。所以借 OpenOPC 的做法，把一部分判据放到运行时持续校验，
 * 结果并进 `/api/diagnostics`。
 *
 * **挑哪几条是有依据的**：每一条都对应本仓库真出过、且今天完全看不见的一类故障。
 * 没有照搬 OpenOPC 的工作项那套——我们没有工作项。
 *
 * 两条纪律与 `diagnostics.ts` 一致：
 * 一条检查塌掉不牵连其余；报错细节只留类别与错误码，不带原始 message。
 */
import { sanitizeErrorDetail } from '../openclaw';

export type InvariantSeverity = 'warning' | 'critical';

export interface RuntimeInvariantIssue {
  code: string;
  severity: InvariantSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export interface InvariantMemberRow {
  id: string;
  group_id: string;
  agent_id: string;
  display_name: string;
  runtime?: string | null;
  external_config?: string | null;
}

export interface InvariantSessionRow {
  group_id: string;
  member_id: string;
  session_id: string;
  status: string;
  last_error: string | null;
}

export interface RuntimeInvariantDeps {
  readConfig: () => Record<string, unknown> | null;
  listGroupMembers: () => InvariantMemberRow[];
  listExternalSessions: () => InvariantSessionRow[];
  heldMemberLocks: () => Array<{ groupId: string; agentId: string; heldMs: number }>;
  binaryExists: (name: string) => boolean;
  pathExists: (path: string) => boolean;
}

/** 与群引擎的成员锁陈旧阈值保持一致。 */
const STALE_LOCK_MS = 15 * 60 * 1000;
/**
 * 同一成员累计这么多条不可续会话才报。
 *
 * **不要调成 1。** 单次不可续可能只是网络抖动、上游限流、用户自己按了 /stop；
 * 按 1 报会让这条变成噪音源，而噪音源最终的下场是被人整条关掉——
 * 那比没有这条检查更糟。累计到 3 次才像系统性问题（凭据失效、工作目录没了、
 * 二进制被卸载）。
 */
const UNUSABLE_SESSION_THRESHOLD = 3;

/** 运行时 → 需要哪个二进制。 */
const RUNTIME_BINARY: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  pi: 'pi',
};

/** 模型 ref 前缀 → 需要哪个二进制（`claude-cli/claude-sonnet-5` 这种写法）。 */
const MODEL_REF_BINARY: Record<string, string> = {
  'claude-cli': 'claude',
  'gemini-cli': 'gemini',
  'codex-cli': 'codex',
};

/** 每条检查单独兜住：排障工具在故障现场崩掉等于没有。 */
function guard(
  code: string,
  issues: RuntimeInvariantIssue[],
  run: () => void,
): void {
  try {
    run();
  } catch (error) {
    issues.push({
      code: 'invariantCheckFailed',
      severity: 'warning',
      message: `检查 ${code} 自身失败`,
      // 只留类别与错误码：message 原文可能嵌着输入（V8 的 JSON 报错就会）。
      details: { check: code, detail: sanitizeErrorDetail(error) },
    });
  }
}

export function checkRuntimeInvariants(deps: RuntimeInvariantDeps): RuntimeInvariantIssue[] {
  const issues: RuntimeInvariantIssue[] = [];

  // ① 成员锁泄漏：外部进程跑飞或漏放锁，那个成员要等 15 分钟才能再说话。
  guard('memberLockStale', issues, () => {
    for (const lock of deps.heldMemberLocks()) {
      if (lock.heldMs <= STALE_LOCK_MS) continue;
      issues.push({
        code: 'memberLockStale',
        severity: 'warning',
        message: `成员 ${lock.agentId} 的运行锁已持有 ${Math.floor(lock.heldMs / 60000)} 分钟`,
        details: { groupId: lock.groupId, agentId: lock.agentId, heldMinutes: Math.floor(lock.heldMs / 60000) },
      });
    }
  });

  const members = (() => {
    try { return deps.listGroupMembers(); } catch { return null; }
  })();

  // ② 孤儿外部会话：这个库的级联是手写的，漏补一行不会报错，
  //    只会让孤儿行越积越多（v1.2.5 那类事故的形状）。
  guard('externalSessionOrphan', issues, () => {
    if (!members) return;
    const known = new Set(members.map((m) => `${m.group_id}|${m.id}`));
    const sessions = deps.listExternalSessions();
    const orphans = sessions.filter((s) => !known.has(`${s.group_id}|${s.member_id}`));
    if (orphans.length > 0) {
      issues.push({
        code: 'externalSessionOrphan',
        severity: 'warning',
        message: `有 ${orphans.length} 条外部会话指向已不存在的成员`,
        details: { count: orphans.length, samples: orphans.slice(0, 3).map((o) => o.member_id) },
      });
    }

    // ③ 不可续会话堆积：同一成员连续多次失败，不像偶发。
    const failures = new Map<string, number>();
    for (const s of sessions) {
      if (String(s.status || 'ok').toLowerCase() === 'ok') continue;
      const key = `${s.group_id}|${s.member_id}`;
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
    for (const [key, count] of failures) {
      if (count < UNUSABLE_SESSION_THRESHOLD) continue;
      issues.push({
        code: 'externalSessionsUnusable',
        severity: 'warning',
        message: `同一成员累计 ${count} 条不可续会话，可能有系统性问题`,
        details: { member: key.split('|')[1], count },
      });
    }
  });

  // 读配置本身也可能抛（文件损坏、权限、命名管道）。它必须和别的检查一样兜住，
  // 否则一个坏配置就让整份不变量报告消失——而那正是最需要它的时刻。
  let config: Record<string, unknown> | null = null;
  guard('readConfig', issues, () => { config = deps.readConfig(); });

  // ④ 名册两种形状并存 = 迁移到一半。`agents-roster` 早就能测出来，但没人消费。
  guard('rosterBothShapes', issues, () => {
    const agents = (config as any)?.agents;
    if (agents && Array.isArray(agents.list) && agents.entries && typeof agents.entries === 'object') {
      issues.push({
        code: 'rosterBothShapes',
        severity: 'critical',
        message: 'agents.list 与 agents.entries 同时存在，配置处于迁移到一半的状态',
        details: {
          listCount: agents.list.length,
          entryCount: Object.keys(agents.entries).length,
        },
      });
    }
  });

  // ⑤ 配置声明了 CLI 后端，主机上却没有对应二进制。
  //    2026-09-12 生产机实测：openclaw.json 声明了 claude-cli / gemini-cli，
  //    而全局 node_modules 里一个都没有。今天谁选中就踩空，且毫无提示。
  guard('cliBackendBinaryMissing', issues, () => {
    const refs = new Set<string>();
    const collect = (value: unknown) => {
      if (typeof value === 'string') {
        const prefix = value.split('/')[0];
        if (MODEL_REF_BINARY[prefix]) refs.add(prefix);
        return;
      }
      if (Array.isArray(value)) { value.forEach(collect); return; }
      if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect((config as any)?.agents);
    for (const prefix of refs) {
      const binary = MODEL_REF_BINARY[prefix];
      if (deps.binaryExists(binary)) continue;
      issues.push({
        code: 'cliBackendBinaryMissing',
        severity: 'critical',
        message: `配置里引用了 ${prefix}，但主机上找不到 ${binary}`,
        details: { modelPrefix: prefix, binary },
      });
    }
  });

  // ⑥ 外部成员配置不可用——「界面显示得像配好了，一 @ 就失败」，
  //    正是本仓库反复出现的那个形状（v1.3.0 / v1.2.6 都是）。
  guard('externalMemberConfig', issues, () => {
    if (!members) return;
    for (const member of members) {
      const runtime = member.runtime || 'openclaw';
      if (runtime === 'openclaw') continue;
      const where = { groupId: member.group_id, memberId: member.id, agentId: member.agent_id, runtime };

      const binary = RUNTIME_BINARY[runtime];
      if (binary && !deps.binaryExists(binary)) {
        issues.push({
          code: 'externalMemberBinaryMissing',
          severity: 'critical',
          message: `成员 ${member.display_name} 配的是 ${runtime}，但主机上找不到 ${binary}`,
          details: { ...where, binary },
        });
      }

      if (!member.external_config) {
        issues.push({
          code: 'externalMemberConfigMissing',
          severity: 'critical',
          message: `成员 ${member.display_name} 是外部运行时但没有配置`,
          details: where,
        });
        continue;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(member.external_config);
      } catch {
        issues.push({
          code: 'externalMemberConfigUnparsable',
          severity: 'critical',
          message: `成员 ${member.display_name} 的外部配置不是合法 JSON`,
          details: where,
        });
        continue;
      }

      if (parsed?.workingDir && !deps.pathExists(String(parsed.workingDir))) {
        issues.push({
          code: 'externalMemberWorkdirMissing',
          severity: 'critical',
          message: `成员 ${member.display_name} 的工作目录不存在`,
          // workingDir 是绝对路径、含用户名——靠 diagnostics 返回前那道脱敏换成 ~。
          details: { ...where, workingDir: String(parsed.workingDir) },
        });
      }
    }
  });

  return issues;
}
