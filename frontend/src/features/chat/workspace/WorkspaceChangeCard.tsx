// 助手消息下方的「N 个文件改动 +a −d」卡片：列出文件，点文件在侧栏打开 diff。
import { FileDiff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { summarizeChanges, type WorkspaceChange, type WorkspaceChangeFile } from './workspaceDiff';

const VISIBLE_FILES = 5;

export function ChangeTypeBadge({ file }: { file: Pick<WorkspaceChangeFile, 'changeType'> }) {
  const { t } = useTranslation();
  const tone = file.changeType === 'added'
    ? 'text-green-700 bg-green-50 border-green-200'
    : file.changeType === 'deleted'
      ? 'text-red-700 bg-red-50 border-red-200'
      : file.changeType === 'renamed'
        ? 'text-blue-700 bg-blue-50 border-blue-200'
        : 'text-amber-700 bg-amber-50 border-amber-200';
  return (
    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      {t(`workspaceDiff.changeType.${file.changeType}`)}
    </span>
  );
}

export function LineCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-green-600">+{additions}</span>{' '}
      <span className="text-red-600">−{deletions}</span>
    </span>
  );
}

export function WorkspaceChangeCard({ changes, onOpen }: {
  changes: WorkspaceChange[];
  onOpen: (change: WorkspaceChange, fileId: number | null) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (changes.length === 0) return null;
  const summary = summarizeChanges(changes);
  const rows = changes.flatMap((change) => change.files.map((file) => ({ change, file })));
  const shown = expanded ? rows : rows.slice(0, VISIBLE_FILES);
  const unrecorded = Math.max(0, summary.fileCount - rows.length);

  return (
    <div className="ml-11 sm:ml-12 mr-4 -mt-3 max-w-2xl rounded-xl border border-gray-200 bg-white" data-testid="workspace-change-card">
      <button
        type="button"
        onClick={() => onOpen(changes[0], null)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left border-b border-gray-100 hover:bg-gray-50 rounded-t-xl"
      >
        <FileDiff className="w-4 h-4 text-gray-400 shrink-0" />
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-gray-700">
          {t('workspaceDiff.filesChanged', { count: summary.fileCount })}
        </span>
        <LineCounts additions={summary.additions} deletions={summary.deletions} />
      </button>
      <ul className="py-1">
        {shown.map(({ change, file }) => (
          <li key={`${change.changeId}:${file.id}`}>
            <button
              type="button"
              onClick={() => onOpen(change, file.id)}
              className="w-full flex items-center gap-2 px-3 py-1 text-left hover:bg-gray-50"
              title={file.oldPath ? t('workspaceDiff.renamedFrom', { path: file.oldPath }) : file.path}
            >
              <ChangeTypeBadge file={file} />
              <span dir="ltr" className="flex-1 min-w-0 truncate font-mono text-[12px] text-gray-700">{file.path}</span>
              {file.binary
                ? <span className="shrink-0 text-[11px] text-gray-400">{t('workspaceDiff.binaryShort')}</span>
                : <LineCounts additions={file.additions} deletions={file.deletions} />}
            </button>
          </li>
        ))}
      </ul>
      {(rows.length > VISIBLE_FILES || unrecorded > 0 || summary.truncated) && (
        <div className="flex flex-wrap items-center gap-3 px-3 py-1.5 border-t border-gray-100 text-[11px] text-gray-500">
          {rows.length > VISIBLE_FILES && (
            <button type="button" className="text-blue-600 hover:text-blue-700" onClick={() => setExpanded((value) => !value)}>
              {expanded ? t('workspaceDiff.showLess') : t('workspaceDiff.showAll', { count: rows.length })}
            </button>
          )}
          {unrecorded > 0 && <span>{t('workspaceDiff.moreFilesNotRecorded', { count: unrecorded })}</span>}
          {summary.truncated && unrecorded === 0 && <span>{t('workspaceDiff.changeTruncated')}</span>}
        </div>
      )}
    </div>
  );
}
