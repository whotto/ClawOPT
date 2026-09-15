/**
 * `.clawpack` 附带工作流：包格式的闸门（数量上限）、导出投影、装包时的严格校验与 Agent 改名映射、只建定义不运行。
 */
import { describe, expect, it } from 'vitest';

import { createAutomation } from '../../src/automation';
import { EventBus } from '../../src/core/events';
import { buildPack, MAX_PACK_WORKFLOWS, parsePack, serializePack } from '../../src/control/packs/agent-pack';
import { edge, memoryDb, node } from './helpers';

function automation() {
  const db = memoryDb();
  return createAutomation({
    db: { connection: () => db, getFileByStoredName: () => undefined } as any,
    sessionManager: { getAllSessions: () => [] } as any,
    agentProvisioner: { getWorkspacePath: () => '/tmp/none' },
    gatewayConnections: {} as any,
    events: new EventBus(),
    fakeRunner: true,
  });
}

const agent = { id: 'writer', name: 'Writer', skills: [], files: [] };

describe('.clawpack 附带工作流', () => {
  it('导出进包、解析出包、装包时按改名映射 Agent 并换新 id；不启动任何运行', () => {
    const source = automation();
    const def = source.workflows.create({ name: 'Report', nodes: [node({ id: 'a', agent: 'writer' }), node('b')], edges: [edge('a', 'b')] });
    const envelopes = source.packBundles.exportEnvelopes([def.id]);
    const pack = buildPack({ kind: 'agent', name: 'p', summary: '', appVersion: '1', agents: [agent], team: null, options: {}, warnings: [], workflows: envelopes });
    expect(pack.manifest.workflowCount).toBe(1);

    const parsed = parsePack(serializePack(pack));
    const target = automation();
    expect(target.packBundles.summarize(parsed.workflows!)).toEqual([{ name: 'Report', nodes: 2, edges: 1, valid: true }]);
    const [result] = target.packBundles.importEnvelopes(parsed.workflows!, { writer: 'writer-2' });
    expect(result.status).toBe('created');
    const imported = target.workflows.get(result.workflowId!);
    expect(imported.nodes.map((n) => n.id)).not.toContain('a');
    expect(imported.nodes.find((n) => n.data.title === 'A')!.data.agent.id).toBe('writer-2');
    expect(target.runStore.listRuns(imported.id, 5)).toEqual([]);
  });

  it('包里的工作流数超过上限：parsePack 直接拒绝', () => {
    const pack = buildPack({ kind: 'agent', name: 'p', summary: '', appVersion: '1', agents: [agent], team: null, options: {}, warnings: [], workflows: [] });
    const raw = { ...pack, workflows: Array.from({ length: MAX_PACK_WORKFLOWS + 1 }, () => ({})) };
    expect(() => parsePack(Buffer.from(JSON.stringify(raw)))).toThrow(expect.objectContaining({ code: 'packs.invalidWorkflows' }));
    expect(() => parsePack(Buffer.from(JSON.stringify({ ...pack, workflows: 'x' })))).toThrow(expect.objectContaining({ code: 'packs.invalidWorkflows' }));
  });

  it('包里的工作流带凭据键：装包时这一条失败，其余不受影响', () => {
    const source = automation();
    const good = source.packBundles.exportEnvelopes([source.workflows.create({ name: 'Good', nodes: [node('a')], edges: [] }).id])[0] as any;
    const bad = JSON.parse(JSON.stringify(good));
    bad.definition.name = 'Bad';
    bad.definition.nodes[0].data.apiKey = 'sk-live';
    const results = automation().packBundles.importEnvelopes([bad, good], {});
    expect(results.map((r) => [r.name, r.status, r.errorCode])).toEqual([['Bad', 'failed', 'workflows.importCredentialKey'], ['Good', 'created', undefined]]);
  });
});
