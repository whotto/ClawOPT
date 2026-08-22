import fs from 'fs';
import os from 'os';
import path from 'path';

export const GROUP_WORKSPACE_PREFIX = 'workspace-group-';
const GROUP_RUNTIME_AGENT_PREFIX = 'group-';
const LEGACY_GROUP_RUNTIME_AGENT_PREFIX = '__clawopt_group_runtime__';
const GROUP_RUNTIME_SESSION_PREFIX = 'group-session-';
const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const GROUP_WORKSPACE_BOOTSTRAP_FILENAMES = [
  'SOUL.md',
  'AGENTS.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
] as const;

export type GroupIdValidationIssue = 'required' | 'whitespace' | 'invalid';

type GroupWorkspacePaths = {
  workspacePath: string;
  uploadsPath: string;
  outputPath: string;
};

export function validateGroupId(raw: unknown): { normalizedId: string; issue: GroupIdValidationIssue | null } {
  const rawId = typeof raw === 'string' ? raw : '';
  const normalizedId = rawId.trim();

  if (!normalizedId) {
    return { normalizedId: '', issue: 'required' };
  }

  if (/\s/.test(rawId)) {
    return { normalizedId, issue: 'whitespace' };
  }

  if (
    normalizedId === '.'
    || normalizedId === '..'
    || normalizedId.includes('/')
    || normalizedId.includes('\\')
    || !GROUP_ID_PATTERN.test(normalizedId)
  ) {
    return { normalizedId, issue: 'invalid' };
  }

  return { normalizedId, issue: null };
}

export function getOpenClawRootDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

function assertValidGroupId(groupId: string): string {
  const validation = validateGroupId(groupId);
  if (validation.issue) {
    throw new Error(`Invalid group id: ${groupId}`);
  }
  return validation.normalizedId;
}

export function getGroupWorkspacePath(groupId: string): string {
  const normalizedId = assertValidGroupId(groupId);
  return path.join(getOpenClawRootDir(), `${GROUP_WORKSPACE_PREFIX}${normalizedId}`);
}

export function getGroupUploadsPath(groupId: string): string {
  return path.join(getGroupWorkspacePath(groupId), 'uploads');
}

export function getGroupOutputPath(groupId: string): string {
  return path.join(getGroupWorkspacePath(groupId), 'output');
}

export function ensureGroupWorkspace(groupId: string): GroupWorkspacePaths {
  const workspacePath = getGroupWorkspacePath(groupId);
  const uploadsPath = path.join(workspacePath, 'uploads');
  const outputPath = path.join(workspacePath, 'output');

  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(uploadsPath, { recursive: true });
  fs.mkdirSync(outputPath, { recursive: true });
  removeGroupWorkspaceBootstrapFiles(groupId);

  return {
    workspacePath,
    uploadsPath,
    outputPath,
  };
}

export function resetGroupWorkspace(groupId: string): GroupWorkspacePaths {
  const workspacePath = getGroupWorkspacePath(groupId);
  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
  return ensureGroupWorkspace(groupId);
}

export function deleteGroupWorkspace(groupId: string): void {
  const workspacePath = getGroupWorkspacePath(groupId);
  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

export function removeGroupWorkspaceBootstrapFiles(groupId: string): void {
  const workspacePath = getGroupWorkspacePath(groupId);
  if (!fs.existsSync(workspacePath)) {
    return;
  }

  for (const filename of GROUP_WORKSPACE_BOOTSTRAP_FILENAMES) {
    const filePath = path.join(workspacePath, filename);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function encodeRuntimeAgentSegment(rawAgentId: string): string {
  const normalizedAgentId = typeof rawAgentId === 'string' ? rawAgentId.trim() : '';
  if (!normalizedAgentId) {
    throw new Error('Invalid source agent id for group runtime');
  }
  return encodeURIComponent(normalizedAgentId);
}

export function getSharedGroupRuntimeAgentId(groupId: string): string {
  const normalizedId = assertValidGroupId(groupId);
  return `${GROUP_RUNTIME_AGENT_PREFIX}${normalizedId}`;
}

export function getGroupRuntimeAgentPrefix(groupId: string): string {
  return `${getSharedGroupRuntimeAgentId(groupId)}--`;
}

export function getGroupRuntimeAgentId(groupId: string, sourceAgentId: string): string {
  return `${getGroupRuntimeAgentPrefix(groupId)}${encodeRuntimeAgentSegment(sourceAgentId)}`;
}

export function getGroupRuntimeSessionKey(groupId: string, runtimeSessionEpoch?: number | null): string {
  const normalizedId = assertValidGroupId(groupId);
  const normalizedEpoch = Number.isFinite(runtimeSessionEpoch as number) && Number(runtimeSessionEpoch) > 0
    ? Math.floor(Number(runtimeSessionEpoch))
    : 0;
  if (normalizedEpoch > 0) {
    return `${GROUP_RUNTIME_SESSION_PREFIX}${normalizedId}-${normalizedEpoch}`;
  }
  return `${GROUP_RUNTIME_SESSION_PREFIX}${normalizedId}`;
}

export function getLegacyGroupRuntimeAgentId(groupId: string): string {
  const normalizedId = assertValidGroupId(groupId);
  return `${LEGACY_GROUP_RUNTIME_AGENT_PREFIX}${normalizedId}`;
}

export function getAgentStatePath(agentId: string): string {
  return path.join(getOpenClawRootDir(), 'agents', agentId);
}

export function getAgentMemoryDbPath(agentId: string): string {
  return path.join(getOpenClawRootDir(), 'memory', `${agentId}.sqlite`);
}
