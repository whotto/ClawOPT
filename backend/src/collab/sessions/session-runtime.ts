import path from 'path';
import fs from 'fs';

import { type AgentProvisioner, readAgentBootstrapContextFromWorkspace } from '../../control';
import { type GatewayConnections, readJsonConfigSafe, readTextFileSafe } from '../../openclaw';
import { getAgentMemoryDbPath, getAgentStatePath } from '../rooms';
import type { SessionManager } from './session-manager';

const AGENT_WORKSPACE_RESET_PRESERVED_ROOT_ENTRIES = new Set([
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
]);
const AGENT_STATE_RESET_PRESERVED_RELATIVE_FILE_PATHS = [
  path.join('agent', 'auth-profiles.json'),
] as const;

export class SessionInterruptedError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was interrupted during processing.`);
    this.name = 'SessionInterruptedError';
  }
}

export function resetAgentWorkspaceToInitialState(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true });

  for (const entry of fs.readdirSync(workspacePath, { withFileTypes: true })) {
    if (AGENT_WORKSPACE_RESET_PRESERVED_ROOT_ENTRIES.has(entry.name)) {
      continue;
    }

    fs.rmSync(path.join(workspacePath, entry.name), { recursive: true, force: true });
  }

  fs.mkdirSync(path.join(workspacePath, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'memory'), { recursive: true });
}

function readPreservedAgentStateFiles(agentStatePath: string): Map<string, Buffer> {
  const preservedFiles = new Map<string, Buffer>();

  for (const relativePath of AGENT_STATE_RESET_PRESERVED_RELATIVE_FILE_PATHS) {
    const absolutePath = path.join(agentStatePath, relativePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    try {
      if (fs.statSync(absolutePath).isFile()) {
        preservedFiles.set(relativePath, fs.readFileSync(absolutePath));
      }
    } catch {}
  }

  return preservedFiles;
}

function restorePreservedAgentStateFiles(agentStatePath: string, preservedFiles: Map<string, Buffer>): void {
  for (const [relativePath, fileContent] of preservedFiles) {
    const absolutePath = path.join(agentStatePath, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, fileContent);
  }
}

/**
 * `sessionFilePath` 来自 `sessions.json` **里面的一个字段**，不是我们构造的路径。
 *
 * 第五轮对抗测试正是从这里进来的，而它揭示的判据比前几轮都更普适：
 * **闸门守的是容器，守不住那只从容器里伸出来指向别处的手。**
 * `sessions.json` 本身已经过网关了，但它内容里的那个路径没有——
 * 在那儿放一个命名管道，发一条群消息就让整个后端永久挂住：
 * 端口还 LISTEN、日志一声不吭、要 kill -9
 * （栈：`node::fs::ReadFileUtf8 → uv_fs_open → open`）。而默认安装不开登录，匿名可达。
 *
 * 判据因此不是「这个文件是不是配置」，而是「**这个路径是不是数据给的**」。
 * 凡是数据给的路径，都要过闸门。
 */
function readRuntimeSessionCwd(sessionFilePath: string): string | null {
  if (!fs.existsSync(sessionFilePath)) return null;

  try {
    const read = readTextFileSafe(sessionFilePath);
    if (!read.exists) return null;
    const firstLine = (read.value as string).split('\n')[0]?.trim();
    if (!firstLine) return null;
    const payload = JSON.parse(firstLine);
    return typeof payload?.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  }
}

export function runtimeAgentSessionsNeedWorkspaceReset(agentId: string, workspacePath: string): boolean {
  const sessionsDir = path.join(getAgentStatePath(agentId), 'sessions');
  if (!fs.existsSync(sessionsDir)) return false;

  const expectedWorkspace = path.resolve(workspacePath);
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');

  if (fs.existsSync(sessionsJsonPath)) {
    try {
      const sessionsRead = readJsonConfigSafe(sessionsJsonPath);
      const payload = sessionsRead.exists ? (sessionsRead.value as any) : null;
      for (const record of Object.values(payload || {})) {
        if (!record || typeof record !== 'object') continue;

        const workspaceDir = typeof (record as { workspaceDir?: unknown }).workspaceDir === 'string'
          ? path.resolve((record as { workspaceDir: string }).workspaceDir)
          : null;
        if (workspaceDir && workspaceDir !== expectedWorkspace) {
          return true;
        }

        const sessionFile = typeof (record as { sessionFile?: unknown }).sessionFile === 'string'
          ? (record as { sessionFile: string }).sessionFile
          : null;
        if (sessionFile && !fs.existsSync(sessionFile)) {
          return true;
        }
        const cwd = sessionFile ? readRuntimeSessionCwd(sessionFile) : null;
        if (cwd && path.resolve(cwd) !== expectedWorkspace) {
          return true;
        }
      }
    } catch {
      return true;
    }
  }

  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const cwd = readRuntimeSessionCwd(path.join(sessionsDir, entry.name));
    if (cwd && path.resolve(cwd) !== expectedWorkspace) {
      return true;
    }
  }

  return false;
}

export type SessionRuntimeDeps = {
  agentProvisioner: AgentProvisioner;
  sessionManager: SessionManager;
  gatewayConnections: GatewayConnections;
};

export function createSessionRuntime(ctx: SessionRuntimeDeps) {
  const { agentProvisioner, sessionManager } = ctx;
  const { disconnectConnection } = ctx.gatewayConnections;

  const sessionInterruptionEpochs = new Map<string, number>();

  function getSessionInterruptionEpoch(sessionId: string): number {
    return sessionInterruptionEpochs.get(sessionId) ?? 0;
  }

  function bumpSessionInterruptionEpoch(sessionId: string): number {
    const nextEpoch = getSessionInterruptionEpoch(sessionId) + 1;
    sessionInterruptionEpochs.set(sessionId, nextEpoch);
    return nextEpoch;
  }

  function assertSessionInterruptionEpoch(sessionId: string, expectedEpoch: number): void {
    if (getSessionInterruptionEpoch(sessionId) !== expectedEpoch) {
      throw new SessionInterruptedError(sessionId);
    }
  }

  function resetAgentRuntimeStateToInitialState(agentId: string): void {
    disconnectConnection(agentId);

    const agentStatePath = getAgentStatePath(agentId);
    const preservedFiles = readPreservedAgentStateFiles(agentStatePath);
    if (fs.existsSync(agentStatePath)) {
      fs.rmSync(agentStatePath, { recursive: true, force: true });
    }
    restorePreservedAgentStateFiles(agentStatePath, preservedFiles);

    const memoryDbPath = getAgentMemoryDbPath(agentId);
    if (fs.existsSync(memoryDbPath)) {
      fs.rmSync(memoryDbPath, { force: true });
    }
  }

  function resetRuntimeAgentSessions(agentId: string): void {
    disconnectConnection(agentId);

    const sessionsDir = path.join(getAgentStatePath(agentId), 'sessions');
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  }

  // Rewrite absolute local file paths in AI responses to HTTP-accessible download URLs
  function getSessionWorkspacePath(sessionId: string): string {
    const sessionInfo = sessionManager.getSession(sessionId);
    const agentId = sessionInfo?.agentId || 'main';
    return agentProvisioner.getWorkspacePath(agentId);
  }

  function readAgentBootstrapIntentContext(agentId: string): string {
    return readAgentBootstrapContextFromWorkspace(agentProvisioner.getWorkspacePath(agentId));
  }

  return {
    sessionInterruptionEpochs,
    getSessionInterruptionEpoch,
    bumpSessionInterruptionEpoch,
    assertSessionInterruptionEpoch,
    resetAgentRuntimeStateToInitialState,
    resetRuntimeAgentSessions,
    getSessionWorkspacePath,
    readAgentBootstrapIntentContext,
  };
}
export type SessionRuntime = ReturnType<typeof createSessionRuntime>;
