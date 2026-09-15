/**
 * 写入审批 + 工作区身份文件编辑器：
 * - 外部改动被暂存并还原成基线；ClawOPT 自己的写入不被暂存；
 * - 批准要求记录未被覆盖（审阅时的哈希）、磁盘仍是基线（否则 409）、识别空补丁；
 * - 同一工作区的批准串行；
 * - 行级 diff 可还原；
 * - 身份文件编辑：锁内比版本号，冲突 412 + 当前内容；软链逃逸拒绝。
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyControlPlaneSchema } from '../src/core/db/control-plane-schema';
import { SafeFileStore } from '../src/core/files/safe-file-store';
import { diffLines, unifiedDiff } from '../src/control/write-gate/line-diff';
import { createWriteGateService, hashContent, isGuardedPath } from '../src/control/write-gate/write-gate-service';
import {
  ABSENT_REVISION,
  contentRevision,
  createWorkspaceFilesService,
  estimateTokens,
  RevisionConflict,
} from '../src/control/workspace-files/workspace-files-service';
import { ControlInputError } from '../src/control/shared/control-http';

let dir: string;
let workspace: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawopt-write-gate-'));
  workspace = path.join(dir, 'workspace-writer');
  fs.mkdirSync(path.join(workspace, 'skills', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n- likes tea\n');
  fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul\n');
  fs.writeFileSync(path.join(workspace, 'skills', 'notes', 'SKILL.md'), '---\nname: notes\n---\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const sqlite = new Database(':memory:');
  applyControlPlaneSchema(sqlite);
  const db = { connection: () => sqlite } as any;
  const roster = { get: async (id: string) => ({ id, workspace, agentDir: null, isDefault: false, bindings: 0 }), list: async () => [], invalidate: () => undefined } as any;
  const fileStore = new SafeFileStore({ crossProcess: false });
  const logs: string[] = [];
  const gate = createWriteGateService({ db, roster, fileStore, watch: () => ({ close: () => undefined }), log: (m) => logs.push(m) });
  return { gate, fileStore, roster, logs };
}

const read = (rel: string) => fs.readFileSync(path.join(workspace, rel), 'utf-8');

describe('受守护路径', () => {
  it('只守 MEMORY/USER/SOUL 与 skills/ 下的非隐藏文件', () => {
    expect(isGuardedPath('MEMORY.md')).toBe(true);
    expect(isGuardedPath('skills/notes/SKILL.md')).toBe(true);
    expect(isGuardedPath('AGENTS.md')).toBe(false);
    expect(isGuardedPath('memory/2026-09-14.md')).toBe(false);
    expect(isGuardedPath('skills/../MEMORY.md')).toBe(false);
    expect(isGuardedPath('skills/.git/config')).toBe(false);
  });
});

describe('写入审批', () => {
  it('开关关着时外部改动不处理', async () => {
    const { gate } = setup();
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'changed');
    expect(await gate.handleChange('writer', workspace, 'MEMORY.md')).toBe('ignored');
    expect(gate.listPending().records).toEqual([]);
  });

  it('外部改动：暂存 + 还原基线；同一文件再改则更新提议而不是新增记录', async () => {
    const { gate } = setup();
    await gate.setEnabled('writer', true);
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n- likes coffee\n');
    expect(await gate.handleChange('writer', workspace, 'MEMORY.md')).toBe('staged');
    expect(read('MEMORY.md')).toBe('# Memory\n- likes tea\n');
    // 还原本身触发的事件被认成预期写入
    expect(await gate.handleChange('writer', workspace, 'MEMORY.md')).toBe('expected');

    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Memory\n- likes juice\n');
    await gate.handleChange('writer', workspace, 'MEMORY.md');
    const { records } = gate.listPending('writer');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ relPath: 'MEMORY.md', action: 'update', proposedHash: hashContent('# Memory\n- likes juice\n') });

    const review = gate.review(records[0].id);
    expect(review.diff).toContain('-- likes tea');
    expect(review.diff).toContain('+- likes juice');
    expect(review.notes).toEqual([]);
  });

  it('新建技能文件被暂存为 create，还原 = 删除；批准后写出', async () => {
    const { gate } = setup();
    await gate.setEnabled('writer', true);
    const rel = 'skills/weather/SKILL.md';
    fs.mkdirSync(path.join(workspace, 'skills', 'weather'), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), '# weather');
    await gate.handleChange('writer', workspace, rel);
    expect(fs.existsSync(path.join(workspace, rel))).toBe(false);
    const [record] = gate.listPending().records;
    expect(record.action).toBe('create');
    await expect(gate.approve(record.id, { baseHash: record.baseHash, proposedHash: record.proposedHash })).resolves.toEqual({ applied: true, noOp: false });
    expect(read(rel)).toBe('# weather');
    // 批准写出的内容成了新基线：再触发一次不会被暂存
    expect(await gate.handleChange('writer', workspace, rel)).not.toBe('staged');
    expect(gate.listPending().records).toEqual([]);
  });

  it('批准的前置条件：审阅后记录被覆盖 → recordChanged；磁盘不再是基线 → baseChanged', async () => {
    const { gate } = setup();
    await gate.setEnabled('writer', true);
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul v2\n');
    await gate.handleChange('writer', workspace, 'SOUL.md');
    const [record] = gate.listPending().records;

    await expect(gate.approve(record.id, { baseHash: record.baseHash, proposedHash: 'stale' })).rejects.toMatchObject({ errorCode: 'writeGate.recordChanged', status: 409 });

    // 有人绕过闸门把磁盘改了（比如服务停着的时候）
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul hand-edited\n');
    await expect(gate.approve(record.id, { baseHash: record.baseHash, proposedHash: record.proposedHash })).rejects.toMatchObject({ errorCode: 'writeGate.baseChanged' });
    expect(gate.review(record.id).notes).toContain('baseChanged');
    expect(read('SOUL.md')).toBe('# Soul hand-edited\n');
  });

  it('空补丁：磁盘已经是提议内容 → 不写盘，只结案', async () => {
    const { gate } = setup();
    await gate.setEnabled('writer', true);
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul v2\n');
    await gate.handleChange('writer', workspace, 'SOUL.md');
    const [record] = gate.listPending().records;
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), '# Soul v2\n');
    expect(gate.review(record.id).notes).toContain('noOp');
    await expect(gate.approve(record.id, { baseHash: record.baseHash, proposedHash: record.proposedHash })).resolves.toEqual({ applied: false, noOp: true });
    expect(gate.listPending().records).toEqual([]);
  });

  it('拒绝：删记录，文件保持基线；ID 不合法 400、不存在 404', async () => {
    const { gate } = setup();
    await gate.setEnabled('writer', true);
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'x');
    await gate.handleChange('writer', workspace, 'MEMORY.md');
    const [record] = gate.listPending().records;
    await expect(gate.reject(record.id)).resolves.toEqual({ rejected: true });
    expect(read('MEMORY.md')).toBe('# Memory\n- likes tea\n');
    expect(() => gate.review('../../etc/passwd')).toThrowError(ControlInputError);
    expect(() => gate.review('00000000-0000-0000-0000-000000000000')).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it('ClawOPT 编辑器自己的写入经 acknowledgeWrite 登记，不被暂存', async () => {
    const { gate, fileStore, roster } = setup();
    await gate.setEnabled('writer', true);
    const files = createWorkspaceFilesService({ roster, fileStore, writeGate: gate });
    const current = await files.read('writer', 'MEMORY.md');
    await files.write('writer', 'MEMORY.md', '# Memory\n- edited in ClawOPT\n', current.revision);
    expect(await gate.handleChange('writer', workspace, 'MEMORY.md')).toBe('expected');
    expect(gate.listPending().records).toEqual([]);
  });

  it('同一工作区的批准串行执行（第二个在第一个写完后才读磁盘）', async () => {
    const { gate, fileStore } = setup();
    await gate.setEnabled('writer', true);
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), 'memory v2');
    await gate.handleChange('writer', workspace, 'MEMORY.md');
    fs.writeFileSync(path.join(workspace, 'SOUL.md'), 'soul v2');
    await gate.handleChange('writer', workspace, 'SOUL.md');
    const [first, second] = gate.listPending().records;

    const order: string[] = [];
    const originalUpdate = fileStore.update.bind(fileStore);
    (fileStore as any).update = async (filePath: string, updater: any) => {
      order.push(`start:${path.basename(filePath)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await originalUpdate(filePath, updater);
      order.push(`end:${path.basename(filePath)}`);
      return result;
    };
    await Promise.all([
      gate.approve(first.id, { baseHash: first.baseHash, proposedHash: first.proposedHash }),
      gate.approve(second.id, { baseHash: second.baseHash, proposedHash: second.proposedHash }),
    ]);
    expect(order).toEqual(['start:MEMORY.md', 'end:MEMORY.md', 'start:SOUL.md', 'end:SOUL.md']);
  });
});

describe('行级 diff', () => {
  const apply = (before: string, after: string) => diffLines(before, after).filter((op) => op.type !== 'delete').map((op) => op.line);
  const beforeLines = (before: string, after: string) => diffLines(before, after).filter((op) => op.type !== 'insert').map((op) => op.line);

  it.each([
    ['', 'a\nb\n'],
    ['a\nb\nc\n', 'a\nc\n'],
    ['a\nb\nc\nd\ne\n', 'x\nb\nc\ny\ne\nz\n'],
    ['same\n', 'same\n'],
  ])('ops 能还原两侧：%j → %j', (before, after) => {
    const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
    expect(apply(before, after)).toEqual(lines(after));
    expect(beforeLines(before, after)).toEqual(lines(before));
  });

  it('没有差异时统一 diff 为空；有差异时带 hunk 头', () => {
    expect(unifiedDiff('a\n', 'a\n', { from: 'a', to: 'b' })).toBe('');
    expect(unifiedDiff('a\nb\n', 'a\nc\n', { from: 'a/x', to: 'b/x' })).toBe('--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c');
  });
});

describe('工作区身份文件', () => {
  function service() {
    const roster = { get: async (id: string) => ({ id, workspace, agentDir: null, isDefault: false, bindings: 0 }) } as any;
    return createWorkspaceFilesService({ roster, fileStore: new SafeFileStore({ crossProcess: false }) });
  }

  it('列表带大小、字数、token 估算与版本号；不存在的文件版本号是 absent', async () => {
    const { files } = await service().list('writer');
    const memory = files.find((file) => file.name === 'MEMORY.md')!;
    expect(memory).toMatchObject({ exists: true, revision: contentRevision('# Memory\n- likes tea\n') });
    expect(files.find((file) => file.name === 'HEARTBEAT.md')).toMatchObject({ exists: false, revision: ABSENT_REVISION });
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('版本号不符 → RevisionConflict（带当前内容），文件不变；缺版本号 428', async () => {
    const files = service();
    await expect(files.write('writer', 'MEMORY.md', 'new', contentRevision('something else'))).rejects.toBeInstanceOf(RevisionConflict);
    try {
      await files.write('writer', 'MEMORY.md', 'new', 'stale');
    } catch (error) {
      expect((error as RevisionConflict).current.content).toBe('# Memory\n- likes tea\n');
    }
    await expect(files.write('writer', 'MEMORY.md', 'new', null)).rejects.toMatchObject({ status: 428 });
    expect(read('MEMORY.md')).toBe('# Memory\n- likes tea\n');

    const created = await files.write('writer', 'HEARTBEAT.md', '# beat', ABSENT_REVISION);
    expect(created.revision).toBe(contentRevision('# beat'));
  });

  it('只认七个文件名；软链指到工作区外拒绝', async () => {
    const files = service();
    await expect(files.read('writer', '../../etc/passwd')).rejects.toMatchObject({ errorCode: 'workspaceFiles.invalidName' });
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'top secret');
    fs.symlinkSync(outside, path.join(workspace, 'TOOLS.md'));
    await expect(files.read('writer', 'TOOLS.md')).rejects.toMatchObject({ errorCode: 'workspaceFiles.unsafePath' });
  });
});
