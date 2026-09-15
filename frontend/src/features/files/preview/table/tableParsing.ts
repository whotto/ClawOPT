/**
 * 表格预览（XLSX / CSV）的纯逻辑：上限裁剪、分隔符识别、CSV 解析。
 * Worker（`tablePreview.worker.ts`）只是把这些函数搬到主线程之外跑，逻辑本身在这里测。
 */

export type TableLimits = {
  maxSheets: number;
  maxRows: number;
  maxCols: number;
  maxCells: number;
  maxCellChars: number;
};

export const DEFAULT_TABLE_LIMITS: TableLimits = Object.freeze({
  maxSheets: 50,
  maxRows: 1000,
  maxCols: 100,
  maxCells: 20_000,
  maxCellChars: 10_000,
});

export type TableTruncation = {
  rows: boolean;
  cols: boolean;
  cells: boolean;
  chars: boolean;
};

export type TableSheet = {
  name: string;
  rows: string[][];
  /** 解析时看到的行数 / 列数（行数可能因解析提前停止而是下限，见 `rowsAtLeast`）。 */
  totalRows: number;
  totalCols: number;
  rowsAtLeast: boolean;
  truncated: TableTruncation;
};

export type TablePreviewResult = {
  sheets: TableSheet[];
  totalSheets: number;
  sheetsTruncated: boolean;
};

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * 把一张表按上限裁成可渲染的矩阵。`parsedRowsExceeded` 表示调用方为了防止超大文件已提前停止解析
 * （所以 `totalRows` 只是下限）。单元格总数上限按「行 × 列」计：列先裁，再按剩余单元格数裁行。
 */
export function capTableRows(name: string, input: ReadonlyArray<ReadonlyArray<unknown>>, limits: TableLimits = DEFAULT_TABLE_LIMITS, parsedRowsExceeded = false): TableSheet {
  const totalRows = input.length;
  const totalCols = input.reduce((max, row) => Math.max(max, row.length), 0);
  const cols = Math.min(totalCols, limits.maxCols);
  const rowsByCells = cols > 0 ? Math.floor(limits.maxCells / cols) : limits.maxRows;
  const rowCount = Math.min(totalRows, limits.maxRows, rowsByCells);
  const truncated: TableTruncation = {
    rows: parsedRowsExceeded || totalRows > limits.maxRows,
    cols: totalCols > limits.maxCols,
    cells: rowCount < Math.min(totalRows, limits.maxRows),
    chars: false,
  };
  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const source = input[r] ?? [];
    const row: string[] = [];
    for (let c = 0; c < cols; c += 1) {
      let text = cellText(source[c]);
      if (text.length > limits.maxCellChars) {
        text = text.slice(0, limits.maxCellChars);
        truncated.chars = true;
      }
      row.push(text);
    }
    rows.push(row);
  }
  return { name, rows, totalRows, totalCols, rowsAtLeast: parsedRowsExceeded, truncated };
}

export function isTableTruncated(sheet: TableSheet): boolean {
  const { rows, cols, cells, chars } = sheet.truncated;
  return rows || cols || cells || chars;
}

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof DELIMITER_CANDIDATES)[number];

/** 数一行里（引号外）某个分隔符出现的次数。 */
function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === delimiter) count += 1;
  }
  return count;
}

/**
 * 分隔符识别：取前 20 个非空行，选「每行都出现、且各行次数最一致」的那个；都没有时回落逗号。
 * 分数 = 出现该分隔符的行数占比 ×（1 / (1 + 次数的离散程度)）× 平均次数的对数权重。
 */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0).slice(0, 20);
  if (lines.length === 0) return ',';
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITER_CANDIDATES) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const present = counts.filter((count) => count > 0);
    if (present.length === 0) continue;
    const mean = present.reduce((sum, count) => sum + count, 0) / present.length;
    const variance = present.reduce((sum, count) => sum + (count - mean) ** 2, 0) / present.length;
    const score = (present.length / lines.length) * (1 / (1 + variance)) * Math.log2(1 + mean);
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/**
 * CSV 解析（RFC 4180：双引号包裹、`""` 转义、引号内可换行）。
 * 读到 `maxRows + 1` 行就停——超大文件不必整份解析完才知道要截断。
 */
export function parseCsv(text: string, delimiter: CsvDelimiter, limits: TableLimits = DEFAULT_TABLE_LIMITS): { rows: string[][]; stoppedEarly: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const pushRow = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };
  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // 单元格文字上限之外的部分不再累加（裁剪阶段也会截，这里防止一个超长引号字段吃光内存）。
      if (field.length <= limits.maxCellChars) field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      pushRow();
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      i += 1;
      if (rows.length > limits.maxRows) return { rows: rows.slice(0, limits.maxRows + 1), stoppedEarly: true };
      continue;
    }
    if (field.length <= limits.maxCellChars) field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return { rows, stoppedEarly: false };
}

export function buildCsvPreview(text: string, limits: TableLimits = DEFAULT_TABLE_LIMITS): TablePreviewResult & { delimiter: CsvDelimiter } {
  const delimiter = detectCsvDelimiter(text);
  const { rows, stoppedEarly } = parseCsv(text, delimiter, limits);
  const sheet = capTableRows('CSV', rows, limits, stoppedEarly);
  return { sheets: [sheet], totalSheets: 1, sheetsTruncated: false, delimiter };
}

/** 工作簿：先裁工作表数，再逐张裁表。 */
export function buildWorkbookPreview(
  sheetNames: ReadonlyArray<string>,
  readSheet: (name: string) => { rows: ReadonlyArray<ReadonlyArray<unknown>>; rowsExceeded: boolean },
  limits: TableLimits = DEFAULT_TABLE_LIMITS,
): TablePreviewResult {
  const visible = sheetNames.slice(0, limits.maxSheets);
  return {
    sheets: visible.map((name) => {
      const { rows, rowsExceeded } = readSheet(name);
      return capTableRows(name, rows, limits, rowsExceeded);
    }),
    totalSheets: sheetNames.length,
    sheetsTruncated: sheetNames.length > limits.maxSheets,
  };
}

/** 文本解码：先严格 UTF-8，失败回落 GBK（与文本预览一致）。 */
export function decodeTableText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gbk').decode(buffer);
  }
}
