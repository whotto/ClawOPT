// 目录列表：图标、名字、git 标注、大小、修改时间与行内动作。窄屏只留名字与动作。
import { Copy, Download, Eye, File, Folder, Link2, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge, EmptyState, formatTime } from '../../../components/control/ControlUi';
import { formatBytes, GIT_BADGE, type FileEntry } from '../lib/fileManagerLogic';

type Props = {
  entries: FileEntry[];
  /** 旁边开着编辑器、列表变窄：收起修改时间列，名字不被挤没。 */
  compact?: boolean;
  activePath: string | null;
  writable: boolean;
  canPreview: boolean;
  downloadUrl: (entry: FileEntry) => string;
  onOpen: (entry: FileEntry) => void;
  onPreview: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onCopy: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
};

const iconButton = 'p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40';

export function EntryTable({ entries, compact = false, activePath, writable, canPreview, downloadUrl, onOpen, onPreview, onRename, onCopy, onDelete }: Props) {
  const { t, i18n } = useTranslation();
  if (entries.length === 0) return <EmptyState>{t('fileManager.page.emptyDir')}</EmptyState>;
  return (
    <div className="divide-y divide-gray-100" data-testid="file-manager-entries">
      {entries.map((entry) => {
        const isDir = entry.kind === 'dir';
        const git = entry.git?.status ? GIT_BADGE[entry.git.status] : null;
        const Icon = isDir ? Folder : entry.kind === 'symlink' ? Link2 : File;
        return (
          <div key={entry.path} className={`flex items-center gap-2 px-3 py-2 ${activePath === entry.path ? 'bg-blue-50/60' : 'hover:bg-gray-50'}`}>
            <button type="button" onClick={() => onOpen(entry)} className="flex items-center gap-2 min-w-0 flex-1 text-left">
              <Icon className={`w-4 h-4 shrink-0 ${isDir ? 'text-blue-500' : 'text-gray-400'}`} />
              <span className="min-w-[3rem] truncate text-sm text-gray-800 font-mono">{entry.name}</span>
              {git && (
                <span className="shrink-0" title={t(`fileManager.git.${entry.git!.status}`)}>
                  <Badge tone={git.tone}>{git.letter}{isDir && entry.git!.changedDescendants > 0 ? ` ${entry.git!.changedDescendants}` : ''}</Badge>
                </span>
              )}
            </button>
            <span className="hidden sm:block w-20 text-right text-xs text-gray-400 shrink-0">{isDir ? '' : formatBytes(entry.size)}</span>
            <span className={`hidden ${compact ? '2xl:block' : 'md:block'} w-44 text-right text-xs text-gray-400 shrink-0`}>{formatTime(entry.mtimeMs, i18n.language)}</span>
            <div className="flex items-center shrink-0">
              {!isDir && canPreview && (
                <button type="button" className={iconButton} title={t('fileManager.actions.preview')} onClick={() => onPreview(entry)}><Eye className="w-4 h-4" /></button>
              )}
              {!isDir && (
                <a className={iconButton} title={t('fileManager.actions.download')} href={downloadUrl(entry)} download={entry.name}><Download className="w-4 h-4" /></a>
              )}
              {writable && (
                <>
                  <button type="button" className={iconButton} title={t('fileManager.actions.rename')} onClick={() => onRename(entry)}><Pencil className="w-4 h-4" /></button>
                  <button type="button" className={`${iconButton} hidden sm:inline-flex`} title={t('fileManager.actions.copy')} onClick={() => onCopy(entry)}><Copy className="w-4 h-4" /></button>
                  <button type="button" className={`${iconButton} hover:text-red-600`} title={t('fileManager.actions.delete')} onClick={() => onDelete(entry)}><Trash2 className="w-4 h-4" /></button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
