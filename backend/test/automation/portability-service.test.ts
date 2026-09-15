/**
 * 导入导出（白名单、凭据键扫描、深度与体积上限、两阶段令牌、id 重映射）与定义服务（存盘编译、级联删除、批量删除）。
 */
import { describe, expect, it } from 'vitest';

import {
  buildEnvelope,
  createImportPreviewStore,
  IMPORT_PREVIEW_TTL_MS,
  MAX_IMPORT_BYTES,
  parseEnvelope,
  parseImportText,
  remapDefinitionIds,
} from '../../src/automation/workflow/portability';
import { createWorkflowService } from '../../src/automation/workflow/workflow-service';
import { edge, node, setupEngine } from './helpers';

function envelope(definition: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { format: 'clawopt.workflow', version: 1, definition: { name: 'imported', nodes: [node('a'), node('b')], edges: [edge('a', 'b')], viewport: null, ...definition }, ...extra };
}

function serviceSetup() {
  const t = setupEngine();
  const cascaded: string[] = [];
  const service = createWorkflowService({
    defs: t.defs,
    engine: t.engine,
    hub: t.hub,
    previews: createImportPreviewStore(t.db),
    cascade: { deleteSchedulesForWorkflow: (id) => cascaded.push(`schedules:${id}`), deleteHooksForWorkflow: (id) => cascaded.push(`hooks:${id}`) },
  });
  return { t, service, cascaded };
}

describe('导出', () => {
  it('白名单投影：丢掉模型绑定与附件路径', () => {
    const a = node('a');
    (a.data as any).model = 'claude-opus';
    (a.data as any).attachments = [{ name: 'x.png', url: '/uploads/x.png' }];
    const t = setupEngine();
    const def = t.defs.create({ name: 'wf', workspace: '/secret/place', nodes: [parseEnvelope(envelope({ nodes: [a], edges: [] })).nodes[0]], edges: [], viewport: null });
    const out = buildEnvelope(def);
    expect(out.format).toBe('clawopt.workflow');
    expect(JSON.stringify(out)).not.toContain('claude-opus');
    expect(JSON.stringify(out)).not.toContain('/uploads/');
    expect(JSON.stringify(out)).not.toContain('/secret/place');
    expect(Object.keys(out.definition.nodes[0].data).sort()).toEqual(['agent', 'approvalRequired', 'input', 'orchestration', 'skills', 'title']);
  });

  it('导出→导入往返：结构保持', () => {
    const t = setupEngine();
    const def = t.create([node('a'), node('b')], [edge('a', 'b', { route: 'always', condition: { path: 'output', operator: 'contains', value: 'ok' } })]);
    const parsed = parseImportText(JSON.stringify(buildEnvelope(t.defs.get(def.id)!)));
    expect(parsed.edges[0].data.orchestration).toEqual({ route: 'always', condition: { path: 'output', operator: 'contains', value: 'ok' } });
  });
});

describe('导入校验', () => {
  it('凭据类键名（大小写、下划线、连字符归一）一律拒绝', () => {
    for (const key of ['apiKey', 'API_KEY', 'access-token', 'Authorization', 'client_secret', 'sessionId', 'run_id', 'password']) {
      const doc = envelope({});
      (doc.definition.nodes[0] as any).data[key] = 'x';
      expect(() => parseEnvelope(doc), key).toThrow(expect.objectContaining({ code: 'workflows.importCredentialKey' }));
    }
  });

  it('凭据键藏在条件值的深处也能扫到', () => {
    const doc = envelope({ edges: [edge('a', 'b', { condition: { path: 'outputJson', operator: 'equals', value: { nested: { Bearer: 'x' } } } })] });
    expect(() => parseEnvelope(doc)).toThrow(expect.objectContaining({ code: 'workflows.importCredentialKey' }));
  });

  it('深度超过 20 拒绝', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 25; i++) deep = { x: deep };
    const doc = envelope({ edges: [edge('a', 'b', { condition: { path: 'outputJson', operator: 'equals', value: deep } })] });
    expect(() => parseEnvelope(doc)).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'tooDeep' }) }));
  });

  it('超过 1 MiB 拒绝；坏 JSON 拒绝', () => {
    expect(() => parseImportText('x'.repeat(MAX_IMPORT_BYTES + 1))).toThrow(expect.objectContaining({ code: 'workflows.importTooLarge' }));
    expect(() => parseImportText('{not json')).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'invalidJson' }) }));
  });

  it('信封键必须恰好是 format / version / definition；格式与版本必须匹配', () => {
    expect(() => parseEnvelope(envelope({}, { extra: 1 }))).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'unknownKey' }) }));
    expect(() => parseEnvelope({ ...envelope({}), format: 'hermes-studio.workflow' })).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'wrongFormat' }) }));
    expect(() => parseEnvelope({ ...envelope({}), version: 2 })).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'wrongVersion' }) }));
  });

  it('每一层白名单：节点多余键、缺 position、定义多余键都拒绝', () => {
    const withExtra = envelope({});
    (withExtra.definition.nodes[0] as any).selected = true;
    expect(() => parseEnvelope(withExtra)).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'unknownKey' }) }));
    const noPosition = envelope({});
    delete (noPosition.definition.nodes[0] as any).position;
    expect(() => parseEnvelope(noPosition)).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'invalidPosition' }) }));
    expect(() => parseEnvelope(envelope({ owner: 'me' }))).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'unknownKey' }) }));
  });

  it('旧版环境字段（model / attachments）接受后丢弃', () => {
    const doc = envelope({});
    (doc.definition.nodes[0] as any).data.model = 'x';
    (doc.definition.nodes[0] as any).data.attachments = [{ name: 'a', url: '/uploads/a' }];
    const parsed = parseEnvelope(doc);
    expect(parsed.nodes[0].data.model).toBeUndefined();
    expect(parsed.nodes[0].data.attachments).toEqual([]);
  });

  it('图必须能编译（环、孤立节点都拒绝）', () => {
    expect(() => parseEnvelope(envelope({ edges: [edge('a', 'b'), edge('b', 'a')] }))).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'forwardCycle' }) }));
    expect(() => parseEnvelope(envelope({ edges: [] }))).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'orphanNode' }) }));
  });

  it('id 重映射：节点与边 id 全换新，边重新指向，Agent 引用可按映射改名', () => {
    const parsed = parseEnvelope(envelope({}));
    const remapped = remapDefinitionIds(parsed, { main: 'renamed' });
    expect(remapped.nodes.map((n) => n.id)).not.toContain('a');
    expect(remapped.edges[0].source).toBe(remapped.nodes[0].id);
    expect(remapped.edges[0].target).toBe(remapped.nodes[1].id);
    expect(remapped.edges[0].id).not.toBe('a-b');
    expect(remapped.nodes[0].data.agent.id).toBe('renamed');
  });
});

describe('两阶段导入', () => {
  it('preview 返回令牌与摘要；confirm 用新 id 建工作流；令牌一次性', () => {
    const { service, t } = serviceSetup();
    const preview = service.previewImport(JSON.stringify(envelope({})));
    expect(preview.summary).toEqual({ name: 'imported', nodes: 2, edges: 1 });
    const created = service.confirmImport(preview.token);
    expect(created.nodes.map((n) => n.id)).not.toContain('a');
    expect(t.defs.list()).toHaveLength(1);
    expect(() => service.confirmImport(preview.token)).toThrow(expect.objectContaining({ status: 409, code: 'workflows.importTokenInvalid' }));
  });

  it('令牌过期 → 409，并且被消费掉', () => {
    let clock = 1_000;
    const t = setupEngine();
    const previews = createImportPreviewStore(t.db, () => clock);
    const preview = previews.create(parseEnvelope(envelope({})));
    clock += IMPORT_PREVIEW_TTL_MS + 1;
    expect(() => previews.consume(preview.token)).toThrow(expect.objectContaining({ status: 409 }));
    clock = 1_000;
    expect(() => previews.consume(preview.token)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('库里的预览被篡改（摘要对不上）→ 409', () => {
    const { service, t } = serviceSetup();
    const preview = service.previewImport(JSON.stringify(envelope({})));
    t.db.prepare('UPDATE workflow_import_previews SET definition_json = ? WHERE token = ?').run(JSON.stringify({ ...parseEnvelope(envelope({})), name: 'evil' }), preview.token);
    expect(() => service.confirmImport(preview.token)).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('令牌存在数据库里：换一个服务实例（模拟重启）照样能确认', () => {
    const { service, t } = serviceSetup();
    const preview = service.previewImport(JSON.stringify(envelope({})));
    const restarted = createImportPreviewStore(t.db);
    expect(restarted.consume(preview.token).name).toBe('imported');
  });

  it('cancel 删除令牌', () => {
    const { service } = serviceSetup();
    const preview = service.previewImport(JSON.stringify(envelope({})));
    expect(service.cancelImport(preview.token)).toBe(true);
    expect(() => service.confirmImport(preview.token)).toThrow(expect.objectContaining({ status: 409 }));
  });
});

describe('定义服务', () => {
  it('存盘时编译：非法图 400，空画布允许，空节点带边拒绝', () => {
    const { service } = serviceSetup();
    expect(() => service.create({ name: 'x', nodes: [node('a'), node('b')], edges: [edge('a', 'b'), edge('b', 'a')] })).toThrow(expect.objectContaining({ status: 400, code: 'workflows.invalidGraph' }));
    expect(service.create({ name: 'empty' }).nodes).toEqual([]);
    expect(() => service.create({ name: 'x', nodes: [], edges: [edge('a', 'b')] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.create({ name: '  ' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.create({ name: 'x', workspace: 'relative/path' })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('服务端强制连通性：孤立节点存不进去', () => {
    const { service } = serviceSetup();
    expect(() => service.create({ name: 'x', nodes: [node('a'), node('b')], edges: [] })).toThrow(expect.objectContaining({ params: expect.objectContaining({ reason: 'orphanNode' }) }));
  });

  it('删除工作流级联：定时、钩子、运行一起删', async () => {
    const { service, t, cascaded } = serviceSetup();
    const def = service.create({ name: 'x', nodes: [node('a')], edges: [] });
    const run = await t.engine.startRun(def.id);
    await t.engine.waitForRun(run.id);
    await service.remove(def.id);
    expect(cascaded).toEqual([`schedules:${def.id}`, `hooks:${def.id}`]);
    expect(t.runStore.getRun(run.id)).toBeNull();
    expect(t.defs.get(def.id)).toBeNull();
  });

  it('批量删除：≤200、去重、逐条回报', async () => {
    const { service } = serviceSetup();
    const a = service.create({ name: 'a' });
    const result = await service.batchDelete([a.id, a.id, 'missing']);
    expect(result).toEqual({ deleted: [a.id], failed: ['missing'], errors: [{ id: 'missing', errorCode: 'workflows.notFound' }] });
    await expect(service.batchDelete(Array.from({ length: 201 }, (_, i) => `id${i}`))).rejects.toMatchObject({ code: 'workflows.batchTooLarge' });
  });
});
