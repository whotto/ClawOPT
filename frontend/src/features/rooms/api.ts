/**
 * 群协作（P3）的 HTTP 接口。登录用户走 `/api/groups/:id/*`；访客页走 `/api/share/rooms/:code/*`（带访客令牌头，见 guest/guestApi.ts）。
 * 返回解析后的 JSON；非 2xx 抛 `RoomApiError(code)`，调用方按错误码取文案（`t(code)`）。
 */
import { apiFetch, jsonInit } from '../../api/client';

export class RoomApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export async function readJson<T = any>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as any;
  if (!response.ok || body?.success === false) {
    const code = body?.errorCode || body?.code || body?.messageCode || (typeof body?.error === 'string' ? body.error : `http.${response.status}`);
    throw new RoomApiError(response.status, String(code), typeof body?.errorDetail === 'string' ? body.errorDetail : undefined);
  }
  return body as T;
}

export type HandoffPolicy = { enabled: boolean; unlimited: boolean; maxDepth: number };
export type RoomPolicyView = {
  groupId: string;
  ownerUserId: number | null;
  handoff: HandoffPolicy;
  summaryModel: string;
  summaryEveryTurns: number;
  summaryGeneration: number;
  runIdleTimeoutSec: number;
  runTotalBudgetSec: number;
  allowGuestAgents: boolean;
  maxGuestAgentsPerMember: number;
  allowRemoteWorkspace: boolean;
  inviteCode: string | null;
  inviteGeneration: number;
};
export type RoomPolicyResponse = { policy: RoomPolicyView; canManage: boolean; canMentionAll: boolean; isOwner: boolean };

export type QueueItem = {
  id: string; messageId: number; memberId: string; targetName: string; textSummary: string; sequence: number; position: number; createdAt: number;
  requesterKind: 'user' | 'guest' | 'agent' | 'system'; requesterUserId: number | null; requesterGuestId: string | null;
};
export type QueueSnapshot = { items: QueueItem[]; busyMembers: string[] };

export type HandoffChain = {
  chainId: string; sourceMessageId: number; currentDepth: number; maxDepth: number; targetMemberId: string; targetName: string;
  status: 'stopped' | 'claimed' | 'resumed' | 'outcome_unknown'; stopReason: string; continueUsed: boolean; actionable: boolean; lastError: string | null; attemptId: string | null;
};

export type SummaryStatus = 'idle' | 'summarizing' | 'success' | 'failed';
export type SummaryState = {
  groupId: string; configured: boolean; model: string; everyTurns: number; summary: string; throughMessageId: number | null;
  summarizedTurnCount: number; status: SummaryStatus; version: number; lastError: string | null; updatedAt: number; pendingTurns: number;
};

export type RoomInteraction = {
  kind: 'approval' | 'clarify'; id: string; sessionKey: string; memberId: string; agentName: string; runId: string; title: string;
  description: string | null; command: string | null; question: string | null; choices: string[] | null; remainingTimeoutMs: number | null;
};

export type WorkspaceEntry = { name: string; path: string; type: 'file' | 'directory'; size: number; modifiedAt: number };
export type WorkspaceFile = { path: string; content: string; sha256: string; size: number };
export type WorkspaceChangeFile = { id: string; path: string; changeType: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; patch: string; binary: boolean; truncated: boolean };
export type WorkspaceChange = {
  id: string; memberId: string; status: 'completed' | 'failed' | 'aborted'; filesChanged: number; additions: number; deletions: number; truncated: boolean; files: WorkspaceChangeFile[]; createdAt: number;
};

export type PairingView = {
  requestId: string; status: 'draft' | 'pending' | 'approved' | 'connecting' | 'rejected' | 'expired' | 'completed' | 'failed';
  requesterKind: 'user' | 'guest'; requesterName: string; requesterUserId: number | null; requesterGuestId: string | null;
  targetOrigin: string | null; descriptor: { runtime: string; name: string; description?: string; mode?: string; model?: string } | null; createdAt: number; expiresAt: number;
};
export type ConnectorView = {
  id: string; memberId: string; status: 'active' | 'revoked'; ownerKind: 'user' | 'guest'; ownerUserId: number | null; targetOrigin: string;
  descriptor: { runtime: string; name: string; description?: string }; online: boolean; createdAt: number; lastSeenAt: number | null; revokedAt: number | null;
};
export type GuestView = { id: string; name: string; avatar: string | null; createdAt: number; lastSeenAt: number };

const g = (groupId: string) => `/groups/${encodeURIComponent(groupId)}`;

export const roomApi = {
  policy: async (groupId: string) => readJson<RoomPolicyResponse>(await apiFetch(`${g(groupId)}/policy`)),
  updatePolicy: async (groupId: string, patch: Partial<{
    handoffEnabled: boolean; handoffUnlimited: boolean; handoffMaxDepth: number; summaryModel: string; summaryEveryTurns: number;
    runIdleTimeoutSec: number; runTotalBudgetSec: number; allowGuestAgents: boolean; maxGuestAgentsPerMember: number; allowRemoteWorkspace: boolean;
  }>) => readJson<{ policy: RoomPolicyView }>(await apiFetch(`${g(groupId)}/policy`, jsonInit('PUT', patch))),

  queue: async (groupId: string) => readJson<QueueSnapshot>(await apiFetch(`${g(groupId)}/queue`)),
  retract: async (groupId: string, messageId: number, queueCapability: string) => readJson(await apiFetch(`${g(groupId)}/messages/${messageId}/retract`, jsonInit('POST', { queueCapability }))),
  interruptMember: async (groupId: string, memberId: string) => readJson(await apiFetch(`${g(groupId)}/members/${encodeURIComponent(memberId)}/interrupt`, { method: 'POST' })),

  handoffs: async (groupId: string) => readJson<{ chains: HandoffChain[]; canManage: boolean }>(await apiFetch(`${g(groupId)}/handoffs`)),
  continueChain: async (groupId: string, chainId: string) => readJson<{ status: string }>(await apiFetch(`${g(groupId)}/handoffs/${encodeURIComponent(chainId)}/continue`, { method: 'POST' })),

  summary: async (groupId: string) => readJson<{ state: SummaryState; anchor: { id: number; sender_name: string; content: string; created_at: string } | null; canManage: boolean }>(await apiFetch(`${g(groupId)}/summary`)),
  editSummary: async (groupId: string, summary: string, expectedVersion: number) => readJson<{ state: SummaryState }>(await apiFetch(`${g(groupId)}/summary`, jsonInit('PUT', { summary, version: expectedVersion }))),
  runSummary: async (groupId: string) => readJson(await apiFetch(`${g(groupId)}/summary/run`, { method: 'POST' })),

  interactions: async (groupId: string) => readJson<{ interactions: RoomInteraction[] }>(await apiFetch(`${g(groupId)}/interactions`)),
  respond: async (groupId: string, interactionId: string, response: { choice?: string; text?: string }) => readJson(await apiFetch(`${g(groupId)}/interactions/${encodeURIComponent(interactionId)}/respond`, jsonInit('POST', response))),

  workspaceList: async (groupId: string, path: string) => readJson<{ path: string; entries: WorkspaceEntry[]; truncated: boolean }>(await apiFetch(`${g(groupId)}/workspace/list?path=${encodeURIComponent(path)}`)),
  workspaceFile: async (groupId: string, path: string) => readJson<{ file: WorkspaceFile }>(await apiFetch(`${g(groupId)}/workspace/file?path=${encodeURIComponent(path)}`)),
  workspaceWrite: async (groupId: string, path: string, content: string, expectedSha256: string | null) => readJson<{ file: { path: string; sha256: string; size: number } }>(await apiFetch(`${g(groupId)}/workspace/file`, jsonInit('PUT', { path, content, expectedSha256 }))),
  workspaceMkdir: async (groupId: string, path: string) => readJson(await apiFetch(`${g(groupId)}/workspace/mkdir`, jsonInit('POST', { path }))),
  workspaceRename: async (groupId: string, from: string, to: string) => readJson(await apiFetch(`${g(groupId)}/workspace/rename`, jsonInit('POST', { from, to }))),
  workspaceDelete: async (groupId: string, path: string, expectedSha256: string | null) => readJson(await apiFetch(`${g(groupId)}/workspace/delete`, jsonInit('POST', { path, expectedSha256 }))),
  workspaceDownloadUrl: (groupId: string, path: string) => `/api${g(groupId)}/workspace/download?path=${encodeURIComponent(path)}`,

  createInvite: async (groupId: string) => readJson<{ inviteCode: string; path: string }>(await apiFetch(`${g(groupId)}/invite`, { method: 'POST' })),
  revokeInvite: async (groupId: string) => readJson(await apiFetch(`${g(groupId)}/invite`, { method: 'DELETE' })),
  guests: async (groupId: string) => readJson<{ guests: GuestView[] }>(await apiFetch(`${g(groupId)}/guests`)),
  revokeGuest: async (groupId: string, guestId: string) => readJson(await apiFetch(`${g(groupId)}/guests/${encodeURIComponent(guestId)}`, { method: 'DELETE' })),

  createPairing: async (groupId: string) => readJson<{ requestId: string; expiresAt: number; pairingCode: string }>(await apiFetch(`${g(groupId)}/relay/pairings`, { method: 'POST' })),
  pairings: async (groupId: string) => readJson<{ pairings: PairingView[]; canDecide: boolean }>(await apiFetch(`${g(groupId)}/relay/pairings`)),
  decidePairing: async (groupId: string, requestId: string, approve: boolean) => readJson(await apiFetch(`${g(groupId)}/relay/pairings/${encodeURIComponent(requestId)}/decision`, jsonInit('POST', { approve }))),
  connectors: async (groupId: string) => readJson<{ connectors: ConnectorView[] }>(await apiFetch(`${g(groupId)}/relay/connectors`)),
  revokeConnector: async (groupId: string, connectorId: string) => readJson(await apiFetch(`${g(groupId)}/relay/connectors/${encodeURIComponent(connectorId)}`, { method: 'DELETE' })),
};

export type RelayLink = {
  id: string; hostUrl: string; roomName: string; roomId: string | null;
  status: 'pending_approval' | 'approved' | 'connecting' | 'connected' | 'disconnected' | 'revoked' | 'failed' | string;
  connected: boolean; lastError: string | null; descriptor: { runtime: string; name: string; description?: string; mode?: string; model?: string };
  trustedLan: boolean; running: boolean; createdAt: number;
};

export const relayLinksApi = {
  list: async () => readJson<{ links: RelayLink[] }>(await apiFetch('/relay/links')),
  create: async (input: { pairingCode: string; runtime: string; name: string; description?: string; mode?: 'global' | 'scoped'; model?: string; trustedLan?: boolean; allowWorkspaceTools?: boolean }) =>
    readJson<{ link: RelayLink }>(await apiFetch('/relay/links', jsonInit('POST', input))),
  remove: async (linkId: string) => readJson(await apiFetch(`/relay/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' })),
  reconnect: async (linkId: string) => readJson(await apiFetch(`/relay/links/${encodeURIComponent(linkId)}/reconnect`, { method: 'POST' })),
};
