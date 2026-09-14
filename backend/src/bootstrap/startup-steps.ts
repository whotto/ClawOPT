import fs from 'fs';

import {
  removeGroupWorkspaceBootstrapFiles,
  type RoomMessages,
  type RoomRuntime,
} from '../collab/rooms';
import {
  type AgentProvisioner,
  patchExecApprovals,
  readMaxPermissionsEnabled,
  synchronizeConfiguredBrowserRepairSettingsBestEffort,
} from '../control';
import type { DB } from '../core/db';
import { previewCacheDir } from '../core/paths';
import {
  synchronizeOpenClawBrowserFillCompatBestEffort,
  synchronizeOpenClawExecPreflightBypassBestEffort,
} from '../openclaw';
import { warmManagedHostToolingInBackground } from '../workspace';

export type StartupStepsDeps = {
  agentProvisioner: AgentProvisioner;
  db: DB;
  roomMessages: RoomMessages;
  roomRuntime: RoomRuntime;
};

export function runStartupSteps(ctx: StartupStepsDeps): void {
  const { agentProvisioner, db } = ctx;
  const { repairLegacyGroupMessageRoots } = ctx.roomMessages;
  const { cleanupLegacyGroupRuntimeArtifacts } = ctx.roomRuntime;

  setImmediate(() => {
    const maxPermissionsEnabled = readMaxPermissionsEnabled() === true;
    patchExecApprovals(maxPermissionsEnabled);
    synchronizeOpenClawExecPreflightBypassBestEffort(maxPermissionsEnabled);
    synchronizeOpenClawBrowserFillCompatBestEffort();
    if (maxPermissionsEnabled) {
      synchronizeConfiguredBrowserRepairSettingsBestEffort();
      warmManagedHostToolingInBackground();
    }
  });

  // Auto-heal legacy group members that stored session IDs instead of OpenClaw agent IDs.
  // This mainly affects the default "main" session whose session ID is random but agentId is "main".
  for (const group of db.getGroupChats()) {
    for (const member of db.getGroupMembers(group.id)) {
      const linkedSession = db.getSession(member.agent_id);
      if (linkedSession && linkedSession.agentId && linkedSession.agentId !== member.agent_id) {
        db.updateGroupMemberAgentId(member.id, linkedSession.agentId);
        console.log(`[Startup] Repaired group member ${member.id}: ${member.agent_id} -> ${linkedSession.agentId}`);
      }
    }
  }

  repairLegacyGroupMessageRoots();

  // Ensure main agent workspace is registered in openclaw.json at startup
  const mainRegistered = agentProvisioner.ensureMainAgent();
  if (mainRegistered) {
    console.log('[Startup] Main agent workspace registered in openclaw.json');
  }

  for (const group of db.getGroupChats()) {
    try {
      cleanupLegacyGroupRuntimeArtifacts(group.id);
      removeGroupWorkspaceBootstrapFiles(group.id);
    } catch (error) {
      console.error(`[Startup] Failed to cleanup legacy runtime artifacts for group ${group.id}:`, error);
    }
  }
  fs.mkdirSync(previewCacheDir, { recursive: true });
}
