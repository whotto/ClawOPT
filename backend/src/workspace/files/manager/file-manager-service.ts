/**
 * 文件管理器（P6，spec 07 §2.8 / §2.9 / §2.13 / §2.14 / §3.3）：可插拔后端（本地 / SSH / Docker）、
 * 根只限 Agent 工作区与管理员配置的额外根、git 状态标注、可续传分块上传。
 *
 * 骨架：实现由 P6 文件管理器分支补齐。
 */
import type { ResourceAccess } from '../../../core/auth';
import type { DB } from '../../../core/db';
import type { HostCapabilities } from '../../../runtime';

export type FileManagerServiceDeps = {
  db: DB;
  access: ResourceAccess;
  /** Agent 工作区（OpenClaw 名册；取不到时按 `workspace-<id>` 约定兜底）。 */
  listAgentWorkspaces: () => Promise<Array<{ agentId: string; workspace: string }>>;
  hostCapabilities: () => Promise<HostCapabilities>;
};

export function createFileManagerService(_deps: FileManagerServiceDeps) {
  return {
    async listRoots(): Promise<unknown[]> {
      return [];
    },
  };
}

export type FileManagerService = ReturnType<typeof createFileManagerService>;
