/**
 * 行级 diff（Myers O(ND)）与统一格式输出。只给写入审批的「审阅」视图用，不追求 git 级别的对齐质量，
 * 追求：结果正确（应用 diff 能从旧文本得到新文本）、有上限（超大文件退化为整段替换，不卡住事件循环）。
 */

export type DiffOp = { type: 'equal' | 'delete' | 'insert'; line: string };

const MAX_EDIT_DISTANCE = 4000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }

  if (!found) {
    // 差异太大：整段替换。仍然是正确的 diff，只是不细。
    return [...a.map((line) => ({ type: 'delete' as const, line })), ...b.map((line) => ({ type: 'insert' as const, line }))];
  }

  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const snapshot = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && snapshot[offset + k - 1] < snapshot[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = snapshot[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'insert', line: b[y - 1] });
      else ops.push({ type: 'delete', line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** 统一格式（`@@ -a,b +c,d @@`），默认 3 行上下文；没有差异返回空串。 */
export function unifiedDiff(before: string, after: string, labels: { from: string; to: string }, context = 3): string {
  const ops = diffLines(before, after);
  if (!ops.some((op) => op.type !== 'equal')) return '';
  const out: string[] = [`--- ${labels.from}`, `+++ ${labels.to}`];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  const positions = ops.map((op) => {
    const position = { oldLine, newLine };
    if (op.type !== 'insert') oldLine += 1;
    if (op.type !== 'delete') newLine += 1;
    return position;
  });
  while (index < ops.length) {
    while (index < ops.length && ops[index].type === 'equal') index += 1;
    if (index >= ops.length) break;
    const start = Math.max(0, index - context);
    let end = index;
    let lastChange = index;
    while (end < ops.length) {
      if (ops[end].type !== 'equal') lastChange = end;
      else if (end - lastChange > context * 2) break;
      end += 1;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.type !== 'insert').length;
    const newCount = hunk.filter((op) => op.type !== 'delete').length;
    const oldStart = oldCount === 0 ? positions[start].oldLine - 1 : positions[start].oldLine;
    const newStart = newCount === 0 ? positions[start].newLine - 1 : positions[start].newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) out.push(`${op.type === 'equal' ? ' ' : op.type === 'delete' ? '-' : '+'}${op.line}`);
    index = end;
  }
  return out.join('\n');
}
