import { describe, expect, it } from 'vitest';
import {
  collectAssistantMessageIds, createRequestSequence, foldUnchangedLines, groupChangesByMessage, parseUnifiedPatch, summarizeChanges, workspaceFileViewTarget,
  type WorkspaceChange,
} from './workspaceDiff';

const change = (over: Partial<WorkspaceChange> = {}): WorkspaceChange => ({
  changeId: 'c1', runId: 'r1', messageId: '5', mode: 'git', fileCount: 2, additions: 3, deletions: 1, truncated: false, createdAt: 0,
  files: [], ...over,
});

describe('workspaceDiff', () => {
  it('解析 unified patch：行号、增删、hunk 里以 --- 开头的删除行不当文件头', () => {
    const lines = parseUnifiedPatch('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n keep\n---removed dashes\n+added\n tail\n');
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'context', 'del', 'add', 'context']);
    expect(lines[4]).toMatchObject({ kind: 'del', text: '--removed dashes', oldNo: 2, newNo: null });
    expect(lines[5]).toMatchObject({ kind: 'add', text: 'added', oldNo: null, newNo: 2 });
    expect(lines[6]).toMatchObject({ oldNo: 3, newNo: 3 });
  });

  it('新文件（-0,0）的行号从 1 开始', () => {
    const lines = parseUnifiedPatch('@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(lines.slice(1).map((l: any) => l.newNo)).toEqual([1, 2]);
  });

  it('折叠长串未改动行：改动前后各留 3 行，文件开头 / 结尾不留', () => {
    const body = Array.from({ length: 20 }, (_, i) => ` c${i}`).join('\n');
    const items = foldUnchangedLines(parseUnifiedPatch(`@@ -1,21 +1,21 @@\n-old\n+new\n${body}\n`));
    const fold = items.find((item) => item.kind === 'fold');
    expect(fold && fold.kind === 'fold' ? fold.lines.length : 0).toBe(17);
    expect(items.filter((item) => item.kind === 'line')).toHaveLength(6);
    expect(foldUnchangedLines(parseUnifiedPatch('@@ -1,4 +1,4 @@\n a\n-b\n+c\n d\n')).some((i) => i.kind === 'fold')).toBe(false);
  });

  it('只取落了库的助手消息 id；按消息分组；合计以服务端为准', () => {
    expect(collectAssistantMessageIds([{ id: '1', role: 'user' }, { id: '2', role: 'assistant' }, { id: 'temp-asst-9', role: 'assistant' }])).toEqual(['2']);
    const grouped = groupChangesByMessage([change(), change({ changeId: 'c2' }), change({ changeId: 'c3', messageId: null })]);
    expect(grouped.get('5')?.map((c) => c.changeId)).toEqual(['c1', 'c2']);
    expect(summarizeChanges([change(), change({ truncated: true })])).toEqual({ fileCount: 4, additions: 6, deletions: 2, truncated: true });
  });

  it('请求序号：只有最后一次请求算数', () => {
    const sequence = createRequestSequence();
    const a = sequence.next();
    const b = sequence.next();
    expect([sequence.isCurrent(a), sequence.isCurrent(b)]).toEqual([false, true]);
  });

  it('查看文件：只有服务端给了候选路径才有目标，文件名取路径最后一段', () => {
    const build = (localPath: string) => `/api/files/download?path=${encodeURIComponent(localPath)}`;
    expect(workspaceFileViewTarget({ path: 'src/a.ts', contentPath: '/w/src/a.ts', binary: false }, build)).toEqual({ url: '/api/files/download?path=%2Fw%2Fsrc%2Fa.ts', filename: 'a.ts' });
    expect(workspaceFileViewTarget({ path: 'gone.txt', contentPath: null, binary: false }, build)).toBeNull();
    expect(workspaceFileViewTarget({ path: 'x', contentPath: '/w/x', binary: false }, () => null)).toBeNull();
  });
});
