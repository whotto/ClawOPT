/**
 * 每次运行的工作区 diff（P1b，spec 01 §2.22）：检查点实现、上限、库表与跟着会话走的清理、协调器接线。
 *
 * git 用例在临时目录里真起 `git init`（不碰任何真实仓库）；非 git 用例是普通临时目录。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import type { WorkspaceRunChangeInput } from '../src/core/db';
import { RunCoordinator, createWorkspaceDiffCheckpointer, type RunProjector, type RunSubmission, type WorkspaceCheckpointer } from '../src/runtime/coordinator';
import { diffLines, formatUnifiedPatch } from '../src/runtime/coordinator/workspace-diff';
import { parseMessageIdsQuery } from '../src/collab/sessions/workspace-change-routes';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

const tmpRoots: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

function write(root: string, rel: string, content: string | Buffer) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function memoryStore() {
  const saved: WorkspaceRunChangeInput[] = [];
  return { saved, store: { save: (input: WorkspaceRunChangeInput) => { saved.push(input); } } };
}

const RUN = { sessionKey: 's1', runId: 'run-1', runMarker: 'run-m1', surface: 'chat' as const };
const DONE = { kind: 'completed' as const, outputText: 'ok' };

describe('行 diff 与 unified patch', () => {
  it('增删行数与 hunk 头正确，上下文窗口重叠的改动并成一个 hunk', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'].join('\n') + '\n';
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'].join('\n') + '\n';
    const diff = diffLines(before, after);
    expect([diff.additions, diff.deletions, diff.degraded]).toEqual([2, 1, false]);
    const patch = formatUnifiedPatch(diff.ops, { oldPath: 'x.txt', newPath: 'x.txt' });
    expect(patch.split('\n').filter((line) => line.startsWith('@@'))).toEqual(['@@ -1,5 +1,5 @@', '@@ -13,3 +13,4 @@']);
    expect(patch).toContain('-b\n+B\n');
    expect(patch.startsWith('--- a/x.txt\n+++ b/x.txt\n')).toBe(true);
  });

  it('新增 / 删除文件的路径是 /dev/null；编辑距离超上限退化成整段替换但结果仍正确', () => {
    const added = diffLines('', 'one\ntwo\n');
    expect(formatUnifiedPatch(added.ops, { oldPath: null, newPath: 'n.txt' })).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
    const degraded = diffLines(a, b, 10);
    expect(degraded.degraded).toBe(true);
    expect([degraded.additions, degraded.deletions]).toEqual([50, 50]);
    expect(diffLines('x\ny\n', 'x\ny\n').additions).toBe(0);
  });
});

describe('git 工作区', () => {
  it('运行前已脏的文件对照检查点快照、干净的对照开始时的 HEAD；运行中提交的也算；改名、删除、二进制、凭据文件', async () => {
    const root = tmpDir('clawopt-wsdiff-git-');
    git(root, 'init', '-q');
    write(root, 'a.txt', 'alpha\n');
    write(root, 'b.txt', 'bravo\n');
    write(root, 'e.txt', 'echo content that moves\n');
    write(root, 'g.txt', 'golf\n');
    write(root, 'image.bin', Buffer.from([0, 1, 2, 3]));
    write(root, 'sub/file.txt', 'tracked in sub\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    // 运行前就脏的未跟踪文件：diff 要对照检查点，而不是当成新增。
    write(root, 'c.txt', 'charlie-before\n');

    const { saved, store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {} });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    expect(checkpoint).not.toBeNull();

    write(root, 'a.txt', 'alpha\nalpha-2\n');
    fs.rmSync(path.join(root, 'b.txt'));
    write(root, 'c.txt', 'charlie-after-longer\n');
    write(root, 'd.txt', 'delta\n');
    fs.renameSync(path.join(root, 'e.txt'), path.join(root, 'f.txt'));
    write(root, 'image.bin', Buffer.from([0, 9, 9, 9, 9]));
    write(root, '.env', 'SECRET=1\n');
    write(root, 'node_modules/pkg/index.js', 'ignored\n');
    // 未跟踪的符号链接指向工作区外：git status 会列出它，但读的时候必须挡住
    const outside = tmpDir('clawopt-wsdiff-git-outside-');
    write(outside, 'secret.txt', 'outside secret\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    fs.mkdirSync(path.join(root, 'linkdir-parent'));
    fs.symlinkSync(outside, path.join(root, 'linkdir-parent', 'escape'));
    // 已跟踪目录被换成指向外面的符号链接：status 里 sub/file.txt 仍在，读它会穿过中间那段链接
    write(outside, 'file.txt', 'outside secret via dir\n');
    fs.rmSync(path.join(root, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'sub'));
    write(root, 'g.txt', 'golf\ngolf-committed\n');
    git(root, 'add', 'g.txt');
    git(root, 'commit', '-q', '-m', 'agent commit');

    const summary = await checkpointer.complete(checkpoint!, { messageId: 42, outcome: DONE });
    expect(summary).not.toBeNull();
    const byPath = Object.fromEntries(summary!.files.map((file) => [file.path, file]));
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'f.txt', 'g.txt', 'image.bin']);
    // 穿过符号链接的路径既不算删除也不算修改：直接不进 diff
    expect(byPath['a.txt']).toMatchObject({ changeType: 'modified', additions: 1, deletions: 0 });
    expect(byPath['b.txt']).toMatchObject({ changeType: 'deleted', additions: 0, deletions: 1 });
    expect(byPath['c.txt']).toMatchObject({ changeType: 'modified', additions: 1, deletions: 1 });
    expect(byPath['d.txt']).toMatchObject({ changeType: 'added', additions: 1 });
    expect(byPath['f.txt']).toMatchObject({ changeType: 'renamed', oldPath: 'e.txt', additions: 0, deletions: 0 });
    expect(byPath['g.txt']).toMatchObject({ changeType: 'modified', additions: 1 });
    expect(byPath['image.bin']).toMatchObject({ changeType: 'modified', binary: true });
    expect(summary).toMatchObject({ messageId: '42', fileCount: 7, additions: 4, deletions: 2, truncated: false });

    expect(saved).toHaveLength(1);
    const row = saved[0];
    expect(row).toMatchObject({ sessionKey: 's1', runId: 'run-1', runMarker: 'run-m1', surface: 'chat', assistantMessageId: '42', mode: 'git' });
    const cPatch = row.files.find((file) => file.path === 'c.txt')!.patch!;
    expect(cPatch).toContain('-charlie-before\n+charlie-after-longer\n');
    expect(row.files.find((file) => file.path === 'image.bin')!.patch).toBeNull();
    expect(JSON.stringify(row)).not.toMatch(/SECRET|outside secret/);
  });

  it('什么都没改：不落库、返回 null；运行前就脏但没动过的文件不算', async () => {
    const root = tmpDir('clawopt-wsdiff-clean-');
    git(root, 'init', '-q');
    write(root, 'a.txt', 'alpha\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    write(root, 'dirty.txt', 'already dirty\n');
    const { saved, store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {} });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    expect(await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE })).toBeNull();
    expect(saved).toEqual([]);
  });

  it('工作区是仓库子目录时只看子目录，路径相对工作区', async () => {
    const repo = tmpDir('clawopt-wsdiff-sub-');
    git(repo, 'init', '-q');
    write(repo, 'outside.txt', 'x\n');
    write(repo, 'ws/inside.txt', 'y\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const { store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {} });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: path.join(repo, 'ws') });
    write(repo, 'outside.txt', 'x changed\n');
    write(repo, 'ws/inside.txt', 'y changed\n');
    const summary = await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE });
    expect(summary!.files.map((file) => file.path)).toEqual(['inside.txt']);
  });
});

describe('非 git 目录', () => {
  it('有界扫描：新增、修改、删除；忽略目录、二进制扩展名、凭据文件与指向外面的符号链接都不进 diff', async () => {
    const root = tmpDir('clawopt-wsdiff-scan-');
    const outside = tmpDir('clawopt-wsdiff-outside-');
    write(outside, 'secret.txt', 'top secret\n');
    write(root, 'keep.md', '# title\n');
    write(root, 'gone.txt', 'bye\n');
    write(root, 'src/app.ts', 'export const a = 1;\n');
    const { saved, store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {} });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });

    write(root, 'src/app.ts', 'export const a = 2;\nexport const b = 3;\n');
    write(root, 'new/notes.txt', 'hello\n');
    fs.rmSync(path.join(root, 'gone.txt'));
    write(root, 'node_modules/x/index.js', 'x\n');
    write(root, 'photo.png', 'not really png\n');
    write(root, 'id_rsa', 'PRIVATE\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));

    const summary = await checkpointer.complete(checkpoint!, { messageId: 7, outcome: DONE });
    expect(summary!.files.map((file) => [file.path, file.changeType, file.additions, file.deletions])).toEqual([
      ['gone.txt', 'deleted', 0, 1],
      ['new/notes.txt', 'added', 1, 0],
      ['src/app.ts', 'modified', 2, 1],
    ]);
    expect(saved[0].mode).toBe('scan');
    expect(JSON.stringify(saved[0])).not.toMatch(/top secret|PRIVATE/);
  });

  it('扫描开始时被上限截断：没扫到的路径不猜成「新增」，变更集标 truncated', async () => {
    const root = tmpDir('clawopt-wsdiff-cap-');
    write(root, 'a.txt', 'a\n');
    write(root, 'b.txt', 'b\n');
    write(root, 'c.txt', 'already here before the run\n');
    const { store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {}, limits: { scanMaxFiles: 2 } });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    // 删掉 a.txt 后，结束时的扫描能看到 c.txt 了——它运行前就在，只是开始时没扫到
    fs.rmSync(path.join(root, 'a.txt'));
    const summary = await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE });
    expect(summary!.files.map((file) => [file.path, file.changeType])).toEqual([['a.txt', 'deleted']]);
    expect(summary!.truncated).toBe(true);
  });

  it('目录数上限：超出的目录不扫，标 truncated', async () => {
    const root = tmpDir('clawopt-wsdiff-dirs-');
    for (let i = 0; i < 5; i += 1) write(root, `d${i}/f.txt`, `file ${i}\n`);
    const { store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {}, limits: { scanMaxDirs: 3 } });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    write(root, 'd0/f.txt', 'file 0 changed\n');
    write(root, 'd4/f.txt', 'file 4 changed but never scanned\n');
    const summary = await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE });
    expect(summary!.files.map((file) => file.path)).toEqual(['d0/f.txt']);
    expect(summary!.truncated).toBe(true);
  });

  it('深度上限同样生效', async () => {
    const root = tmpDir('clawopt-wsdiff-depth-');
    const { store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {}, limits: { scanMaxDepth: 1 } });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    write(root, 'a/b/deep.txt', 'deep\n');
    write(root, 'top.txt', 'top\n');
    const summary = await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE });
    expect(summary!.files.map((file) => file.path)).toEqual(['top.txt']);
    expect(summary!.truncated).toBe(true);
  });
});

describe('上限与截断', () => {
  it('文件数超上限只存前面的；单文件与总 patch 超上限不给 patch；超过快照上限的文件只报改了', async () => {
    const root = tmpDir('clawopt-wsdiff-limits-');
    write(root, 'big.txt', 'x'.repeat(300) + '\n');
    const { saved, store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({
      store,
      log: () => {},
      limits: { maxFiles: 3, maxPatchBytesPerFile: 120, maxPatchBytesTotal: 60, maxSnapshotBytes: 200 },
    });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    write(root, 'big.txt', 'y'.repeat(320) + '\n');
    write(root, 'a.txt', 'a\n');
    write(root, 'b.txt', 'b\n');
    write(root, 'c.txt', 'c'.repeat(150) + '\n');
    write(root, 'd.txt', 'd\n');

    const summary = await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE });
    expect(summary!.fileCount).toBe(5);
    expect(summary!.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'big.txt']);
    expect(summary!.truncated).toBe(true);
    const rows = Object.fromEntries(saved[0].files.map((file) => [file.path, file]));
    expect(rows['a.txt'].patch).not.toBeNull();
    // 第二个 patch 让总量超过 60 字节：不给 patch、标截断
    expect(rows['b.txt']).toMatchObject({ patch: null, truncated: true });
    expect(rows['big.txt']).toMatchObject({ changeType: 'modified', patch: null, truncated: true, binary: false });
    expect(saved[0].patchBytes).toBeLessThanOrEqual(60);
  });

  it('单个 patch 超过每文件上限：不给 patch', async () => {
    const root = tmpDir('clawopt-wsdiff-onefile-');
    const { saved, store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {}, limits: { maxPatchBytesPerFile: 50 } });
    const checkpoint = await checkpointer.begin({ ...RUN, workspacePath: root });
    write(root, 'long.txt', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
    await checkpointer.complete(checkpoint!, { messageId: 1, outcome: DONE });
    expect(saved[0].files[0]).toMatchObject({ path: 'long.txt', additions: 20, patch: null, truncated: true });
  });

  it('没有工作区、工作区不存在：不打检查点', async () => {
    const { store } = memoryStore();
    const checkpointer = createWorkspaceDiffCheckpointer({ store, log: () => {} });
    expect(await checkpointer.begin({ ...RUN })).toBeNull();
    expect(await checkpointer.begin({ ...RUN, workspacePath: path.join(os.tmpdir(), 'clawopt-does-not-exist-xyz') })).toBeNull();
  });
});

describe('协调器接线', () => {
  function setup(checkpointer: WorkspaceCheckpointer) {
    const hub = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    hub.listen('test', (event) => events.push(event));
    const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), checkpointer, log: () => {} });
    const scripted = scriptedAdapter();
    const submission = (workspacePath: string): RunSubmission<any> => ({
      sessionKey: 's1',
      surface: 'chat',
      topics: ['session:s1'],
      agentId: 'main',
      adapter: scripted.adapter,
      request: {},
      workspacePath,
      projector: (): RunProjector => ({ onEvent: () => {}, finish: () => ({ messageId: 99 }) }),
    });
    return { coordinator, scripted, events, submission };
  }

  it('运行中改的文件出现在 workspace.diff.completed 与终态负载里，挂到最终消息 id 上', async () => {
    const root = tmpDir('clawopt-wsdiff-coord-');
    const { saved, store } = memoryStore();
    const { coordinator, scripted, events, submission } = setup(createWorkspaceDiffCheckpointer({ store, log: () => {} }));
    const submitted = await coordinator.submit(submission(root), 'reject');
    for (let i = 0; i < 20 && scripted.runs.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    write(root, 'made-by-agent.txt', 'hello\n');
    scripted.runs[0].finish(DONE);
    const terminal = await (submitted as any).completion;
    expect(terminal.workspaceChange).toMatchObject({ messageId: '99', fileCount: 1, files: [{ path: 'made-by-agent.txt', changeType: 'added' }] });
    const diffEvent = events.find((event) => event.type === 'workspace.diff.completed');
    expect((diffEvent?.payload as any)?.changeId).toBe(terminal.workspaceChange.changeId);
    const completed = events.find((event) => event.type === 'run.completed');
    expect((completed?.payload as any).workspace_run_change.changeId).toBe(terminal.workspaceChange.changeId);
    expect(saved[0]).toMatchObject({ assistantMessageId: '99', surface: 'chat' });
  });

  it('检查点开始失败、比对失败、落库失败都不影响运行：照常完成，没有改动卡片', async () => {
    const root = tmpDir('clawopt-wsdiff-fail-');
    const broken: WorkspaceCheckpointer = {
      begin: async () => { throw new Error('begin boom'); },
      complete: async () => { throw new Error('complete boom'); },
    };
    const first = setup(broken);
    const submitted = await first.coordinator.submit(first.submission(root), 'reject');
    for (let i = 0; i < 20 && first.scripted.runs.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    first.scripted.runs[0].finish(DONE);
    const terminal = await (submitted as any).completion;
    expect(terminal.outcome.kind).toBe('completed');
    expect(terminal.workspaceChange).toBeNull();

    const failingStore = { save: () => { throw new Error('disk full'); } };
    const second = setup(createWorkspaceDiffCheckpointer({ store: failingStore, log: () => {} }));
    const again = await second.coordinator.submit(second.submission(root), 'reject');
    for (let i = 0; i < 20 && second.scripted.runs.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    write(root, 'x.txt', 'x\n');
    second.scripted.runs[0].finish(DONE);
    const terminal2 = await (again as any).completion;
    expect(terminal2.outcome.kind).toBe('completed');
    expect(terminal2.workspaceChange).toBeNull();
    await flush();
  });
});

describe('库表：按消息取、懒加载 patch、跟着会话走', () => {
  let home = '';
  let previousHome: string | undefined;
  let previousDataDir: string | undefined;
  let db: any;

  beforeAll(async () => {
    home = tmpDir('clawopt-wsdiff-db-');
    previousHome = process.env.HOME;
    previousDataDir = process.env.CLAWOPT_DATA_DIR;
    process.env.HOME = home;
    process.env.CLAWOPT_DATA_DIR = '.wsdiff';
    const { DB } = await import('../src/core/db');
    db = new DB();
  });
  afterAll(() => {
    process.env.HOME = previousHome;
    if (previousDataDir === undefined) delete process.env.CLAWOPT_DATA_DIR;
    else process.env.CLAWOPT_DATA_DIR = previousDataDir;
  });

  const change = (id: string, sessionKey: string, messageId: string): WorkspaceRunChangeInput => ({
    id, sessionKey, surface: 'chat', runId: `r-${id}`, runMarker: `m-${id}`, assistantMessageId: messageId, mode: 'scan',
    fileCount: 1, additions: 1, deletions: 0, patchBytes: 10, truncated: false, createdAt: Date.now(),
    files: [{ path: 'a.txt', oldPath: null, changeType: 'added', additions: 1, deletions: 0, oldSize: null, newSize: 2, patch: '+a\n', patchBytes: 3, truncated: false, binary: false }],
  });

  it('摘要不带 patch 正文；patch 只能按所属会话取', () => {
    db.workspaceRunChanges.save(change('c1', 'sess-a', '10'));
    db.workspaceRunChanges.save(change('c2', 'sess-b', '10'));
    const listed = db.workspaceRunChanges.listForMessages('sess-a', ['10', '11']);
    expect(listed.map((item: any) => item.changeId)).toEqual(['c1']);
    expect(listed[0].files[0]).toMatchObject({ path: 'a.txt', hasPatch: true });
    expect(listed[0].files[0]).not.toHaveProperty('patch');
    const fileId = listed[0].files[0].id;
    expect(db.workspaceRunChanges.getFilePatch('sess-a', 'c1', fileId)?.patch).toBe('+a\n');
    expect(db.workspaceRunChanges.getFilePatch('sess-b', 'c1', fileId)).toBeNull();
  });

  it('删会话、清空历史、删消息、删群、删工作流会话数据都带走变更集', () => {
    db.saveSession({ id: 'sess-del', name: 'D', agentId: 'main', created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    db.workspaceRunChanges.save(change('d1', 'sess-del', '1'));
    db.deleteSession('sess-del');
    expect(db.workspaceRunChanges.listForMessages('sess-del', ['1'])).toEqual([]);

    db.workspaceRunChanges.save(change('d2', 'sess-clear', '1'));
    db.deleteMessagesBySession('sess-clear');
    expect(db.workspaceRunChanges.listForMessages('sess-clear', ['1'])).toEqual([]);

    const user = Number(db.saveMessage({ session_key: 'sess-msg', role: 'user', content: 'hi' }));
    const reply = Number(db.saveMessage({ session_key: 'sess-msg', parent_id: user, role: 'assistant', content: 'ok' }));
    db.workspaceRunChanges.save(change('d3', 'sess-msg', String(reply)));
    db.workspaceRunChanges.save(change('d3-other', 'sess-other-msg', String(reply)));
    db.deleteMessage(reply);
    expect(db.workspaceRunChanges.listForMessages('sess-msg', [String(reply)])).toEqual([]);
    expect(db.workspaceRunChanges.listForMessages('sess-other-msg', [String(reply)])).toHaveLength(1);

    db.saveGroupChat({ id: 'g_1', name: 'G' });
    db.workspaceRunChanges.save(change('d4', 'room:g_1:member:m1', '5'));
    db.workspaceRunChanges.save(change('d5', 'room:gx1:member:m1', '5'));
    db.deleteGroupChat('g_1');
    expect(db.workspaceRunChanges.listForMessages('room:g_1:member:m1', ['5'])).toEqual([]);
    expect(db.workspaceRunChanges.listForMessages('room:gx1:member:m1', ['5'])).toHaveLength(1);

    db.workspaceRunChanges.save(change('d6', 'workflow:w1', '1'));
    db.deleteRunSessionData('workflow:w1');
    expect(db.workspaceRunChanges.listForMessages('workflow:w1', ['1'])).toEqual([]);
    const orphanFiles = db.connection().prepare('SELECT COUNT(*) AS n FROM workspace_run_change_files WHERE change_id NOT IN (SELECT id FROM workspace_run_changes)').get();
    expect(orphanFiles.n).toBe(0);
  });

  it('查询串里的消息 id 只收安全形状并去重', () => {
    expect(parseMessageIdsQuery('1, 2,2,../x,abc_9')).toEqual(['1', '2', 'abc_9']);
    expect(parseMessageIdsQuery(undefined)).toEqual([]);
  });
});
