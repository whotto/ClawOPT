// 每次运行的工作区改动（P1b）：接口形状与纯函数（patch 解析、未改动行折叠、摘要）。组件只管展示。

export type WorkspaceChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface WorkspaceChangeFile {
  id: number;
  path: string;
  oldPath: string | null;
  changeType: WorkspaceChangeType;
  additions: number;
  deletions: number;
  oldSize: number | null;
  newSize: number | null;
  patchBytes: number;
  truncated: boolean;
  binary: boolean;
  hasPatch: boolean;
}

export interface WorkspaceChange {
  changeId: string;
  runId: string;
  messageId: string | null;
  mode: 'git' | 'scan';
  fileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  createdAt: number;
  files: WorkspaceChangeFile[];
}

export interface WorkspaceFilePatch {
  id: number;
  path: string;
  oldPath: string | null;
  changeType: WorkspaceChangeType;
  patch: string | null;
  truncated: boolean;
  binary: boolean;
}

/** 这一页里能挂改动卡片的消息：落了库的助手消息（临时 id 还没有服务端记录）。只取最近的 200 条。 */
export function collectAssistantMessageIds(messages: ReadonlyArray<{ id: string; role: string }>, limit = 200): string[] {
  const ids = messages
    .filter((message) => message.role === 'assistant' && /^\d+$/.test(message.id))
    .map((message) => message.id);
  return ids.slice(-limit);
}

export function groupChangesByMessage(changes: ReadonlyArray<WorkspaceChange>): Map<string, WorkspaceChange[]> {
  const map = new Map<string, WorkspaceChange[]>();
  for (const change of changes) {
    if (!change.messageId) continue;
    const list = map.get(change.messageId) ?? [];
    list.push(change);
    map.set(change.messageId, list);
  }
  return map;
}

export type DiffLine =
  | { kind: 'meta'; text: string }
  | { kind: 'hunk'; text: string }
  | { kind: 'context' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null };

/** 解析 unified patch（服务端按 `--- / +++ / @@ -a,b +c,d @@` 写出）。认不出的行按 meta 原样显示，不丢。 */
export function parseUnifiedPatch(patch: string): DiffLine[] {
  const lines = patch.endsWith('\n') ? patch.slice(0, -1).split('\n') : patch.split('\n');
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[3]);
      // 行数为 0 的一侧，起始行号是「前一行」；下一行从它 + 1 开始。
      if (header[2] !== '0') oldNo -= 1;
      if (header[4] !== '0') newNo -= 1;
      inHunk = true;
      out.push({ kind: 'hunk', text: line });
      continue;
    }
    // 第一个 hunk 之前是文件头（`--- a/x`、`+++ b/x`）；hunk 里以 `---` 开头的是被删掉的 `--` 行，不是文件头。
    if (!inHunk) {
      out.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      newNo += 1;
      out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo });
    } else if (line.startsWith('-')) {
      oldNo += 1;
      out.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null });
    } else if (line.startsWith(' ') || line === '') {
      oldNo += 1;
      newNo += 1;
      out.push({ kind: 'context', text: line.slice(1), oldNo, newNo });
    } else {
      out.push({ kind: 'meta', text: line });
    }
  }
  return out;
}

export type DiffViewItem =
  | { kind: 'line'; line: DiffLine }
  | { kind: 'fold'; id: string; lines: DiffLine[] };

/**
 * 折叠长串未改动的上下文行：改动前后各留 `keep` 行，中间超过 `minFold` 行的收成一行「N 行未改动」。
 * 服务端 patch 的上下文本来就只有 3 行；这里兜的是整段替换退化、或别处给来的大上下文 patch。
 */
export function foldUnchangedLines(lines: ReadonlyArray<DiffLine>, options: { keep?: number; minFold?: number } = {}): DiffViewItem[] {
  const keep = options.keep ?? 3;
  const minFold = options.minFold ?? 8;
  const items: DiffViewItem[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== 'context') {
      items.push({ kind: 'line', line: lines[index] });
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].kind === 'context') end += 1;
    const run = lines.slice(index, end);
    const atStart = index === 0 || lines[index - 1].kind === 'hunk' || lines[index - 1].kind === 'meta';
    const atEnd = end === lines.length || lines[end].kind === 'hunk';
    const head = atStart ? 0 : keep;
    const tail = atEnd ? 0 : keep;
    if (run.length - head - tail >= minFold) {
      run.slice(0, head).forEach((line) => items.push({ kind: 'line', line }));
      items.push({ kind: 'fold', id: `fold-${index}`, lines: run.slice(head, run.length - tail) });
      run.slice(run.length - tail).forEach((line) => items.push({ kind: 'line', line }));
    } else {
      run.forEach((line) => items.push({ kind: 'line', line }));
    }
    index = end;
  }
  return items;
}

/** 卡片上的合计：以服务端合计为准（它包含没落库的文件）；缺了就按文件行加总。 */
export function summarizeChanges(changes: ReadonlyArray<WorkspaceChange>): { fileCount: number; additions: number; deletions: number; truncated: boolean } {
  return changes.reduce((acc, change) => ({
    fileCount: acc.fileCount + (Number.isFinite(change.fileCount) ? change.fileCount : change.files.length),
    additions: acc.additions + (Number.isFinite(change.additions) ? change.additions : change.files.reduce((sum, file) => sum + file.additions, 0)),
    deletions: acc.deletions + (Number.isFinite(change.deletions) ? change.deletions : change.files.reduce((sum, file) => sum + file.deletions, 0)),
    truncated: acc.truncated || change.truncated,
  }), { fileCount: 0, additions: 0, deletions: 0, truncated: false });
}

/** 请求序号守卫：只有最后一次发起的请求能落到状态上（慢的旧请求回来不覆盖新的）。 */
export function createRequestSequence() {
  let current = 0;
  return {
    next(): number { current += 1; return current; },
    isCurrent(token: number): boolean { return token === current; },
    invalidate(): void { current += 1; },
  };
}
