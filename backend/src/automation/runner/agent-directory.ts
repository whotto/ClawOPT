/**
 * 节点可选的 Agent 名册：ClawOPT 的 OpenClaw 角色（会话表里的 agentId）+ 运行时平台登记处里的编码类外部运行时。
 * 技能来自各自的技能目录：OpenClaw 角色是 `<工作区>/skills/<名>/SKILL.md`，Claude Code 是 `~/.claude/skills/<名>/SKILL.md`。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SessionManager } from '../../collab/sessions';
import { readTextFileSafe } from '../../openclaw';
import type { AgentDirectory, AgentDirectoryEntry, WorkflowAgentRef } from '../ports';

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_SKILL_BYTES = 256 * 1024;

/** 外部运行时目录（bootstrap 从运行时平台的登记处与管理器组装；清单只有登记处一份）。 */
export type ExternalRuntimeCatalog = {
  /** 能作为工作流节点的运行时（编码类 CLI；远程 OpenClaw 要群成员令牌，不在内）。 */
  list(): Array<{ id: string; name: string; modes: readonly string[]; approvals: boolean }>;
  /** 本机装没装（同步判据：管理器缓存的检测结果）。 */
  installed(id: string): boolean;
  /** 重新检测（名册接口调用前刷新缓存）。 */
  refresh?(): Promise<void>;
};

export type AgentDirectoryDeps = {
  sessionManager: Pick<SessionManager, 'getAllSessions'>;
  workspacePathFor: (agentId: string) => string;
  runtimes: ExternalRuntimeCatalog;
  homeDir?: string;
  /** 假 Runner 模式：一切 Agent 视为可用（本机演示不依赖 OpenClaw 网关与外部 CLI）。 */
  fakeRunner?: boolean;
};

export function createAgentDirectory(deps: AgentDirectoryDeps): AgentDirectory {
  function skillsRoot(ref: WorkflowAgentRef): string | null {
    if (ref.kind === 'openclaw') return path.join(deps.workspacePathFor(ref.id), 'skills');
    if ((ref.runtime ?? ref.id) === 'claude-code') return path.join(deps.homeDir ?? os.homedir(), '.claude', 'skills');
    return null;
  }

  function listSkills(ref: WorkflowAgentRef): string[] {
    const root = skillsRoot(ref);
    if (!root) return [];
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && SKILL_NAME.test(entry.name) && fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  function readSkill(ref: WorkflowAgentRef, name: string): string | null {
    if (!SKILL_NAME.test(name)) return null;
    const root = skillsRoot(ref);
    if (!root) return null;
    try {
      const file = path.join(root, name, 'SKILL.md');
      if (fs.statSync(file).size > MAX_SKILL_BYTES) return null;
      // 经网关读：不是普通文件（目录、命名管道）直接拒绝，不会把后端挂住。
      const result = readTextFileSafe(file);
      return result.exists ? String(result.value) : null;
    } catch {
      return null;
    }
  }

  function openclawAgents() {
    const seen = new Set<string>();
    const out: Array<{ id: string; name: string }> = [];
    for (const session of deps.sessionManager.getAllSessions()) {
      // 外部运行时单聊的会话 Agent 不是 OpenClaw 角色（外部运行时在下面按登记处列）。
      if (!session.agentId || session.external_runtime || seen.has(session.agentId)) continue;
      seen.add(session.agentId);
      out.push({ id: session.agentId, name: session.name || session.agentId });
    }
    if (deps.fakeRunner && !out.length) out.push({ id: 'main', name: 'main' });
    return out;
  }

  function availability(ref: WorkflowAgentRef) {
    if (deps.fakeRunner) return { available: true as const };
    if (ref.kind === 'openclaw') {
      return openclawAgents().some((agent) => agent.id === ref.id)
        ? { available: true as const }
        : { available: false as const, reason: `OpenClaw agent ${ref.id} is not in the roster` };
    }
    const runtime = ref.runtime ?? ref.id;
    if (!deps.runtimes.list().some((item) => item.id === runtime)) return { available: false as const, reason: `runtime ${runtime} has no adapter` };
    if (!deps.runtimes.installed(runtime)) return { available: false as const, reason: `runtime ${runtime} is not installed on this host` };
    const mode = ref.mode ?? 'global';
    const modes = deps.runtimes.list().find((item) => item.id === runtime)?.modes ?? [];
    if (modes.length > 0 && !modes.includes(mode)) return { available: false as const, reason: `runtime ${runtime} does not support ${mode} mode` };
    return { available: true as const };
  }

  return {
    async list(): Promise<AgentDirectoryEntry[]> {
      await deps.runtimes.refresh?.().catch(() => undefined);
      const openclaw = openclawAgents().map((agent) => {
        const ref: WorkflowAgentRef = { kind: 'openclaw', id: agent.id };
        return { ref, name: agent.name, available: true, skills: listSkills(ref) };
      });
      const external = deps.runtimes.list().map((runtime) => {
        const ref: WorkflowAgentRef = { kind: 'external', id: runtime.id, runtime: runtime.id };
        const verdict = availability(ref);
        return {
          ref,
          name: runtime.name,
          available: verdict.available,
          ...(verdict.available ? {} : { reason: verdict.reason }),
          skills: listSkills(ref),
          modes: [...runtime.modes],
          approvals: runtime.approvals,
        };
      });
      return [...openclaw, ...external];
    },
    availability,
    readSkill,
    listSkills,
  };
}
