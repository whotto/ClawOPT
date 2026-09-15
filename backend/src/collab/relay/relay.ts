/**
 * relay 的组装：host（配对存储 + WebSocket 接入 + 远程成员适配器 + 远程工作区令牌）与 target（本机链接）。
 * 同一个 ClawOPT 实例可以同时是 host（别人的 Agent 接进来）和 target（自己的 Agent 接出去）。
 */
import type { IncomingMessage } from 'http';
import path from 'path';

import type { DB } from '../../core/db';
import type { Resolver } from '../../core/net';
import { LocalSecretBox, type AgentRuntimeAdapter, type RunCoordinator, type RuntimeRunRequest } from '../../runtime';
import type { RoomCollab } from '../rooms';
import { createHostPairingStore } from './host-pairing-store';
import { createRelayHost } from './relay-host';
import { createRelayTarget } from './relay-target';

export type RelayDeps = {
  db: DB;
  roomCollab: RoomCollab;
  runCoordinator: Pick<RunCoordinator, 'submit' | 'abort' | 'respondInteraction'>;
  createAdapter: (runtime: string) => AgentRuntimeAdapter<RuntimeRunRequest> | null;
  emitMessage: (payload: Record<string, unknown>) => void;
  isHostAllowed: (req: IncomingMessage) => boolean;
  dataDir: string;
  resolver?: Resolver;
  log?: (message: string) => void;
};

export function createRelay(deps: RelayDeps) {
  const conn = deps.db.connection();
  const pairings = createHostPairingStore(conn);
  const host = createRelayHost({
    db: deps.db,
    pairings,
    collab: deps.roomCollab,
    emitMessage: deps.emitMessage,
    isHostAllowed: deps.isHostAllowed,
    log: deps.log,
  });
  const target = createRelayTarget({
    conn,
    runCoordinator: deps.runCoordinator,
    createAdapter: deps.createAdapter,
    secretBox: new LocalSecretBox(path.join(deps.dataDir, 'relay', 'link-secrets.key')),
    dataDir: deps.dataDir,
    resolver: deps.resolver,
    log: deps.log,
  });
  deps.roomCollab.useRelay({
    isConnectorOnline: (connectorId) => host.isConnectorOnline(connectorId),
    issueWorkspaceGrant: (input) => host.issueWorkspaceGrant(input),
    revokeGuestAgents: (groupId, guestId) => {
      const revoked: string[] = [];
      for (const row of pairings.listConnectors(groupId)) {
        if (row.owner_kind !== 'guest' || row.owner_guest_id !== guestId || row.status === 'revoked') continue;
        host.revokeConnector(row.id, 'guest revoked');
        revoked.push(row.member_id);
      }
      return revoked;
    },
  });
  return {
    pairings,
    host,
    target,
    start() {
      target.start();
    },
    stop() {
      target.stop();
      host.close();
    },
  };
}

export type Relay = ReturnType<typeof createRelay>;
