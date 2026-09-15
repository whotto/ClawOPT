import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DOCUMENT_PREVIEW_SCROLL_CLASS, DOCUMENT_PREVIEW_SURFACE_CLASS, TEXT_SELECTION_STYLE } from '../previewUtils';
import { DEFAULT_TABLE_LIMITS, isTableTruncated, type TablePreviewResult } from './tableParsing';

/** 表格预览：工作表切换 + 截断说明 + 纯 React 表格（不再把 xlsx 生成的 HTML 塞进 innerHTML）。 */
export function TablePreview({ result }: { result: TablePreviewResult }) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const sheet = result.sheets[Math.min(activeIndex, Math.max(0, result.sheets.length - 1))];
  const limits = DEFAULT_TABLE_LIMITS;

  return (
    <div className={DOCUMENT_PREVIEW_SCROLL_CLASS}>
      <div className={`${DOCUMENT_PREVIEW_SURFACE_CLASS} overflow-hidden`}>
        {result.sheets.length > 1 && (
          <div className="flex gap-1 overflow-x-auto px-4 pt-3 pb-2 border-b border-gray-100">
            {result.sheets.map((entry, index) => (
              <button
                key={`${index}:${entry.name}`}
                type="button"
                onClick={() => setActiveIndex(index)}
                className={`h-8 px-3 flex-shrink-0 rounded-lg text-xs whitespace-nowrap transition-colors border ${
                  index === activeIndex
                    ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {entry.name}
              </button>
            ))}
          </div>
        )}

        {(result.sheetsTruncated || (sheet && isTableTruncated(sheet))) && (
          <div className="mx-4 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 space-y-0.5">
            {result.sheetsTruncated && <p>{t('filePreviewSafety.tableSheetsTruncated', { shown: result.sheets.length, total: result.totalSheets })}</p>}
            {sheet && (sheet.truncated.rows || sheet.truncated.cols || sheet.truncated.cells) && (
              <p>
                {t(sheet.rowsAtLeast ? 'filePreviewSafety.tableTruncatedAtLeast' : 'filePreviewSafety.tableTruncated', {
                  rows: sheet.rows.length,
                  cols: sheet.rows[0]?.length ?? 0,
                  totalRows: sheet.rowsAtLeast ? limits.maxRows : sheet.totalRows,
                  totalCols: sheet.totalCols,
                })}
              </p>
            )}
            {sheet?.truncated.chars && <p>{t('filePreviewSafety.tableCellsClipped', { chars: limits.maxCellChars })}</p>}
          </div>
        )}

        {!sheet || sheet.rows.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-gray-400">{t('filePreviewSafety.tableEmpty')}</p>
        ) : (
          <div className="overflow-auto p-4 sm:p-6" style={TEXT_SELECTION_STYLE}>
            <table className="border-collapse text-[13px] text-gray-800">
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  <tr key={rowIndex} className={rowIndex === 0 ? 'bg-gray-50 font-semibold' : 'even:bg-gray-50/60'}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="border border-gray-200 px-3 py-1.5 align-top whitespace-pre-wrap break-words max-w-[360px]">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
