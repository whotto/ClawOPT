/**
 * 外部运行时节点的运行时目录归属 `{workflow-node, 工作流, 节点}`：删工作流即回收；定期清扫按「节点还在」判孤儿
 * （看板派活是 `kanban` / 任务 id）。bootstrap 的 `homeOwnerExists` 接到 `automation.runtimeHomeOwnerExists`。
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { createAutomation } from '../../src/automation';
import { DEFAULT_BOARD_ID } from '../../src/automation/kanban/kanban-store';
import { EventBus } from '../../src/core/events';
import { memoryDb, node } from './helpers';

describe('工作流节点的运行时目录归属', () => {
  it('节点在才算归属存在；删工作流回收该工作流的全部运行时目录；看板任务按任务 id', async () => {
    const released: unknown[] = [];
    const db = memoryDb();
    const automation = createAutomation({
      db: { connection: () => db, getFileByStoredName: () => undefined } as any,
      sessionManager: { getAllSessions: () => [] } as any,
      agentProvisioner: { getWorkspacePath: () => '/tmp/none' },
      gatewayConnections: {} as any,
      events: new EventBus(),
      runtimePlatform: { releaseOwner: (owner: unknown) => { released.push(owner); } } as any,
      fakeRunner: true,
    } as any);
    const def = automation.workflows.create({ name: 'wf', nodes: [node('a')], edges: [] });
    expect(automation.runtimeHomeOwnerExists(def.id, 'a')).toBe(true);
    expect(automation.runtimeHomeOwnerExists(def.id, 'gone')).toBe(false);
    const task = automation.kanban.createTask(DEFAULT_BOARD_ID, { title: 't', assignee: { kind: 'external', id: 'codex' } });
    expect(automation.runtimeHomeOwnerExists('kanban', task.id)).toBe(true);
    expect(automation.runtimeHomeOwnerExists('kanban', 'missing')).toBe(false);

    await automation.workflows.remove(def.id);
    expect(released).toEqual([{ kind: 'workflow-node', workflowId: def.id }]);
    expect(automation.runtimeHomeOwnerExists(def.id, 'a')).toBe(false);
  });

  it('装配：bootstrap 的运行时目录清扫判据把工作流节点交给自动化（不是一律当存在）', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'bootstrap', 'context.ts'), 'utf-8');
    expect(source).toContain('automation.runtimeHomeOwnerExists(owner.workflowId, owner.nodeId)');
  });
});
