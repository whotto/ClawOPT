// 右侧 diff 面板：左列这一轮改动的文件，右边懒加载选中文件的 patch（未改动行折叠、二进制与截断提示）。
import { ChevronRight, FileDiff, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getWorkspaceChangeFile } from '../../../api/workspaceChanges';
import { ChangeTypeBadge, LineCounts } from './WorkspaceChangeCard';
import {
  createRequestSequence, foldUnchangedLines, parseUnifiedPatch,
  type DiffViewItem, type WorkspaceChange, type WorkspaceFilePatch,
} from './workspaceDiff';

type PatchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; file: WorkspaceFilePatch };

function DiffRows({ items }: { items: DiffViewItem[] }) {
  const { t } = useTranslation();
  const [openFolds, setOpenFolds] = useState<Set<string>>(new Set());
  const rows = items.flatMap((item) => (item.kind === 'fold' && openFolds.has(item.id) ? item.lines.map((line) => ({ kind: 'line' as const, line })) : [item]));
  return (
    <table className="w-full border-collapse font-mono text-[12px] leading-5">
      <tbody>
        {rows.map((item, index) => {
          if (item.kind === 'fold') {
            return (
              <tr key={`${item.id}-${index}`}>
                <td colSpan={3} className="bg-gray-50 px-3 py-0.5">
                  <button type="button" className="text-blue-600 hover:text-blue-700" onClick={() => setOpenFolds((prev) => new Set(prev).add(item.id))}>
                    {t('workspaceDiff.unchangedLines', { count: item.lines.length })}
                  </button>
                </td>
              </tr>
            );
          }
          const { line } = item;
          if (line.kind === 'meta' || line.kind === 'hunk') {
            return (
              <tr key={index}>
                <td colSpan={3} className={`px-3 whitespace-pre ${line.kind === 'hunk' ? 'bg-blue-50 text-blue-700' : 'text-gray-400'}`}>{line.text}</td>
              </tr>
            );
          }
          const tone = line.kind === 'add' ? 'bg-green-50' : line.kind === 'del' ? 'bg-red-50' : '';
          const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
          return (
            <tr key={index} className={tone}>
              <td className="w-10 select-none pr-2 text-right text-gray-400 align-top">{line.oldNo ?? ''}</td>
              <td className="w-10 select-none pr-2 text-right text-gray-400 align-top">{line.newNo ?? ''}</td>
              <td className="whitespace-pre-wrap break-all pl-1 pr-3 text-gray-800"><span className="select-none text-gray-400">{sign}</span>{line.text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function WorkspaceDiffPanel({ sessionId, change, initialFileId, onClose }: {
  sessionId: string;
  change: WorkspaceChange;
  initialFileId: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [fileId, setFileId] = useState<number | null>(initialFileId ?? change.files[0]?.id ?? null);
  const [patch, setPatch] = useState<PatchState>({ status: 'idle' });
  const sequenceRef = useRef(createRequestSequence());

  useEffect(() => {
    setFileId(initialFileId ?? change.files[0]?.id ?? null);
  }, [change.changeId, initialFileId]);

  useEffect(() => {
    if (fileId === null) {
      setPatch({ status: 'idle' });
      return;
    }
    const token = sequenceRef.current.next();
    const controller = new AbortController();
    setPatch({ status: 'loading' });
    getWorkspaceChangeFile(sessionId, change.changeId, fileId, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!sequenceRef.current.isCurrent(token)) return;
        setPatch(response.ok && payload?.file ? { status: 'ready', file: payload.file } : { status: 'error' });
      })
      .catch((error) => {
        if ((error as Error)?.name === 'AbortError' || !sequenceRef.current.isCurrent(token)) return;
        setPatch({ status: 'error' });
      });
    return () => controller.abort();
  }, [change.changeId, fileId, sessionId]);

  useEffect(() => () => sequenceRef.current.invalidate(), []);

  const items = useMemo(() => (
    patch.status === 'ready' && patch.file.patch ? foldUnchangedLines(parseUnifiedPatch(patch.file.patch)) : []
  ), [patch]);
  const selected = change.files.find((file) => file.id === fileId) ?? null;

  return (
    <div className="fixed inset-0 z-[120] flex justify-end" role="dialog" aria-label={t('workspaceDiff.panelTitle')} data-testid="workspace-diff-panel">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative flex h-full w-full md:w-[min(960px,80vw)] flex-col border-l border-gray-200 bg-white">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <FileDiff className="h-4 w-4 text-gray-400" />
          <span className="flex-1 text-sm font-semibold text-gray-800">{t('workspaceDiff.panelTitle')}</span>
          <LineCounts additions={change.additions} deletions={change.deletions} />
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label={t('common.close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul className="max-h-48 shrink-0 overflow-y-auto border-b border-gray-200 md:max-h-none md:w-64 md:border-b-0 md:border-r">
            {change.files.map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  onClick={() => setFileId(file.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${file.id === fileId ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  <ChangeTypeBadge file={file} />
                  <span dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-700" title={file.path}>{file.path}</span>
                  {file.id === fileId && <ChevronRight className="h-3.5 w-3.5 text-blue-500" />}
                </button>
              </li>
            ))}
            {change.truncated && <li className="px-3 py-2 text-[11px] text-gray-400">{t('workspaceDiff.changeTruncated')}</li>}
          </ul>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            {selected && (
              <div dir="ltr" className="sticky top-0 border-b border-gray-100 bg-white px-3 py-2 font-mono text-[12px] text-gray-600">
                {selected.oldPath ? `${selected.oldPath} → ${selected.path}` : selected.path}
              </div>
            )}
            {patch.status === 'loading' && (
              <div className="flex items-center gap-2 px-4 py-6 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />{t('workspaceDiff.loadingPatch')}</div>
            )}
            {patch.status === 'error' && <div className="px-4 py-6 text-sm text-red-600">{t('workspaceDiff.patchLoadFailed')}</div>}
            {patch.status === 'ready' && patch.file.binary && <div className="px-4 py-6 text-sm text-gray-500">{t('workspaceDiff.binaryUnavailable')}</div>}
            {patch.status === 'ready' && !patch.file.binary && !patch.file.patch && <div className="px-4 py-6 text-sm text-gray-500">{t('workspaceDiff.patchNotRecorded')}</div>}
            {patch.status === 'ready' && items.length > 0 && <DiffRows items={items} />}
            {patch.status === 'ready' && patch.file.truncated && <div className="border-t border-gray-100 px-4 py-2 text-[11px] text-amber-700">{t('workspaceDiff.patchTruncated')}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
