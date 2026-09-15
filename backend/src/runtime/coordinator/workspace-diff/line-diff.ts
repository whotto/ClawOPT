/**
 * 行级 diff 与 unified patch（纯函数，不起 git：非 git 目录也要能给 patch，git 工作区里「运行前」的版本也常常只在内存里）。
 *
 * 算法：先剥掉公共前缀与后缀，中间段用 Myers O(ND)；编辑距离超过上限就把中间段整体按「删 + 加」给出——
 * 结果仍然是正确的补丁，只是不再最短（防止两个完全不同的大文件把事件循环卡住）。
 */
export type DiffOp = { kind: 'equal' | 'delete' | 'insert'; line: string };

export interface LineDiffResult {
  ops: DiffOp[];
  additions: number;
  deletions: number;
  /** 编辑距离超过上限、退化成整段替换。 */
  degraded: boolean;
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function myersMiddle(a: string[], b: string[], maxD: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, d);
    }
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], dEnd: number): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d -= 1) {
    const vd = trace[d]; // 覆盖 k ∈ [-d-1, d+1]，下标 = k + d + 1
    const at = (k: number) => vd[k + d + 1];
    const k = x - y;
    const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; ops.push({ kind: 'equal', line: a[x] }); }
    if (x === prevX) { y -= 1; ops.push({ kind: 'insert', line: b[y] }); }
    else { x -= 1; ops.push({ kind: 'delete', line: a[x] }); }
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; ops.push({ kind: 'equal', line: a[x] }); }
  return ops.reverse();
}

export function diffLines(before: string, after: string, maxEditDistance = 2_000): LineDiffResult {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let middle = myersMiddle(midA, midB, maxEditDistance);
  const degraded = middle === null;
  if (!middle) {
    middle = [...midA.map((line) => ({ kind: 'delete' as const, line })), ...midB.map((line) => ({ kind: 'insert' as const, line }))];
  }
  const ops: DiffOp[] = [
    ...a.slice(0, start).map((line) => ({ kind: 'equal' as const, line })),
    ...middle,
    ...a.slice(endA).map((line) => ({ kind: 'equal' as const, line })),
  ];
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === 'insert') additions += 1;
    else if (op.kind === 'delete') deletions += 1;
  }
  return { ops, additions, deletions, degraded };
}

/** 按 unified 格式（上下文 3 行）写出 hunk。没有改动返回空串。 */
export function formatUnifiedPatch(ops: DiffOp[], paths: { oldPath: string | null; newPath: string | null }, context = 3): string {
  const changed: number[] = [];
  ops.forEach((op, index) => { if (op.kind !== 'equal') changed.push(index); });
  if (changed.length === 0) return '';

  // 相邻改动的上下文窗口重叠就并成一个 hunk。
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  // 每个 op 之前已经过了多少行旧文件 / 新文件。
  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const op of ops) {
    oldLineAt.push(oldLine);
    newLineAt.push(newLine);
    if (op.kind !== 'insert') oldLine += 1;
    if (op.kind !== 'delete') newLine += 1;
  }

  const out: string[] = [
    `--- ${paths.oldPath === null ? '/dev/null' : `a/${paths.oldPath}`}`,
    `+++ ${paths.newPath === null ? '/dev/null' : `b/${paths.newPath}`}`,
  ];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((op) => op.kind !== 'insert').length;
    const newCount = slice.filter((op) => op.kind !== 'delete').length;
    const oldStart = oldCount === 0 ? oldLineAt[from] : oldLineAt[from] + 1;
    const newStart = newCount === 0 ? newLineAt[from] : newLineAt[from] + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind === 'equal' ? ' ' : op.kind === 'delete' ? '-' : '+'}${op.line}`);
  }
  return `${out.join('\n')}\n`;
}

/** 前 8000 字节里有 NUL 就当二进制（与 git 的判据同一思路）。 */
export function looksBinary(content: Buffer): boolean {
  const end = Math.min(content.length, 8000);
  for (let i = 0; i < end; i += 1) if (content[i] === 0) return true;
  return false;
}
