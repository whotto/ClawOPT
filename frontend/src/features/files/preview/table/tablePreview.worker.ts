/**
 * 表格解析 Worker：xlsx 库只在这里加载（Worker 本身按需创建），解析卡住或撑爆内存时死的是 Worker，不是页面。
 * 调用方在超时、关闭预览、换文件时直接 terminate。
 */
import * as XLSX from 'xlsx';
import {
  buildCsvPreview,
  buildWorkbookPreview,
  decodeTableText,
  DEFAULT_TABLE_LIMITS,
} from './tableParsing';
import type { TableWorkerRequest, TableWorkerResponse } from './tableWorkerProtocol';

/** 只用到 onmessage / postMessage 两个成员；不引 webworker lib（与 DOM lib 同一个编译单元会冲突）。 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<TableWorkerRequest>) => void) | null;
  postMessage(message: TableWorkerResponse): void;
};

scope.onmessage = (event: MessageEvent<TableWorkerRequest>) => {
  const { id, kind, buffer } = event.data;
  const limits = DEFAULT_TABLE_LIMITS;
  let response: TableWorkerResponse;
  try {
    if (kind === 'csv') {
      response = { id, ok: true, result: buildCsvPreview(decodeTableText(buffer), limits) };
    } else {
      // 先只读工作表名，再只解析前 maxSheets 张、每张前 maxRows + 1 行（多读一行才知道要不要标截断）。
      const names = XLSX.read(buffer, { type: 'array', bookSheets: true }).SheetNames;
      const visible = names.slice(0, limits.maxSheets);
      const workbook = XLSX.read(buffer, { type: 'array', sheets: visible, sheetRows: limits.maxRows + 1, cellHTML: false });
      response = {
        id,
        ok: true,
        result: buildWorkbookPreview(names, (name) => {
          const sheet = workbook.Sheets[name];
          const rows = sheet ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true }) : [];
          return { rows, rowsExceeded: rows.length > limits.maxRows };
        }, limits),
      };
    }
  } catch (error) {
    response = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(response);
};
