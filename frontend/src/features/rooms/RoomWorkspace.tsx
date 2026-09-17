// 群共享工作区（P3 任务 7）：管理员的文件浏览 / 编辑抽屉（写入按 SHA-256 乐观并发），以及挂在 Agent 回复下的「本次运行改了哪些文件」卡片。
import { ChevronRight, Download, File, FileDiff, Folder, FolderPlus, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RoomApiError, roomApi, type WorkspaceChange, type WorkspaceEntry, type WorkspaceFile } from './api';

export function RoomWorkspaceDrawer({ groupId, refreshTick, onClose }: { groupId: string; refreshTick: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorText = (err: unknown) => (err instanceof RoomApiError ? String(t(err.code, { defaultValue: err.message })) : String((err as Error)?.message ?? err));

  const load = useCallback(async (path: string) => {
    try {
      const result = await roomApi.workspaceList(groupId, path);
      setEntries(result.entries);
      setDir(result.path);
      setError('');
    } catch (err) {
      if (err instanceof RoomApiError && err.code === 'workspace.notFound' && path) return load('');
      setError(errorText(err));
    }
  }, [groupId]);

  useEffect(() => { void load(dir); }, [load, refreshTick]);

  const open = async (entry: WorkspaceEntry) => {
    if (entry.type === 'directory') return load(entry.path);
    try {
      const result = await roomApi.workspaceFile(groupId, entry.path);
      setFile(result.file);
      setDraft(result.file.content);
      setError('');
    } catch (err) {
      setError(errorText(err));
    }
  };

  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await roomApi.workspaceWrite(groupId, file.path, draft, file.sha256);
      setFile({ ...file, content: draft, sha256: result.file.sha256, size: result.file.size });
      setError('');
      void load(dir);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!file || !window.confirm(t('rooms.workspace.confirmDelete', { path: file.path }))) return;
    try {
      await roomApi.workspaceDelete(groupId, file.path, file.sha256);
      setFile(null);
      void load(dir);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const mkdir = async () => {
    const name = window.prompt(t('rooms.workspace.newFolder'));
    if (!name) return;
    try {
      await roomApi.workspaceMkdir(groupId, dir ? `${dir}/${name}` : name);
      void load(dir);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const crumbs = dir ? dir.split('/') : [];
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose} data-testid="room-workspace-drawer">
      <aside className="h-full w-full lg:w-[56rem] bg-white shadow-xl flex flex-col" onClick={(event) => event.stopPropagation()}>
        <header className="h-14 px-4 flex items-center gap-2 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900 flex-1">{t('rooms.workspace.title')}</h2>
          <button type="button" onClick={mkdir} className="p-2 text-gray-500 hover:text-gray-800" title={t('rooms.workspace.newFolder')}><FolderPlus className="w-4 h-4" /></button>
          <button type="button" onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700" aria-label={t('common.close')}><X className="w-5 h-5" /></button>
        </header>
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          <div className={`${file ? 'hidden md:flex' : 'flex'} md:w-72 flex-col border-r border-gray-100 min-h-0`}>
            <div className="px-3 py-2 text-xs text-gray-500 flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => load('')} className="hover:text-blue-600">{t('rooms.workspace.root')}</button>
              {crumbs.map((crumb, index) => (
                <span key={index} className="inline-flex items-center gap-1">
                  <ChevronRight className="w-3 h-3" />
                  <button type="button" onClick={() => load(crumbs.slice(0, index + 1).join('/'))} className="hover:text-blue-600">{crumb}</button>
                </span>
              ))}
            </div>
            <ul className="flex-1 overflow-y-auto">
              {entries.length === 0 && <li className="px-3 py-2 text-sm text-gray-400">{t('rooms.workspace.empty')}</li>}
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" onClick={() => void open(entry)} className={`w-full px-3 py-2 flex items-center gap-2 text-sm text-left hover:bg-gray-50 ${file?.path === entry.path ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}`}>
                    {entry.type === 'directory' ? <Folder className="w-4 h-4 text-amber-500" /> : <File className="w-4 h-4 text-gray-400" />}
                    <span className="truncate flex-1">{entry.name}</span>
                    {entry.type === 'file' && <span className="text-[11px] text-gray-400">{formatBytes(entry.size)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className={`${file ? 'flex' : 'hidden md:flex'} flex-1 min-h-0 flex-col`}>
            {file ? (
              <>
                <div className="px-3 py-2 flex items-center gap-2 border-b border-gray-100">
                  <button type="button" onClick={() => setFile(null)} className="md:hidden text-xs text-blue-600">{t('common.back', { defaultValue: '←' })}</button>
                  <span className="text-xs font-mono text-gray-600 truncate flex-1">{file.path}</span>
                  <a href={roomApi.workspaceDownloadUrl(groupId, file.path)} className="p-1.5 text-gray-500 hover:text-gray-800" title={t('rooms.workspace.download')}><Download className="w-4 h-4" /></a>
                  <button type="button" onClick={remove} className="p-1.5 text-gray-400 hover:text-red-600" title={t('common.delete')}><Trash2 className="w-4 h-4" /></button>
                  <button type="button" disabled={busy || draft === file.content} onClick={save} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-blue-600 text-white disabled:opacity-40"><Save className="w-3.5 h-3.5" />{t('common.save')}</button>
                </div>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} className="flex-1 min-h-[50vh] md:min-h-0 w-full resize-none p-3 font-mono text-xs focus:outline-none" data-testid="room-workspace-editor" />
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400">{t('rooms.workspace.pick')}</div>
            )}
          </div>
        </div>
        {error && <p className="px-4 py-2 text-xs text-red-600 border-t border-red-100 bg-red-50">{error}</p>}
      </aside>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Agent 回复下的工作区改动卡：文件列表 + 展开看 patch。 */
export function WorkspaceChangesCard({ changes }: { changes: WorkspaceChange[] }) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  const visible = changes.filter((change) => change.filesChanged > 0);
  if (visible.length === 0) return null;
  return (
    <div className="mt-2 space-y-2" data-testid="room-workspace-changes">
      {visible.map((change) => (
        <div key={change.id} className="rounded-xl border border-gray-200 bg-gray-50/60 text-xs">
          <div className="px-3 py-2 flex items-center gap-2 text-gray-600">
            <FileDiff className="w-3.5 h-3.5" />
            <span className="flex-1">{t('rooms.workspace.changed', { count: change.filesChanged })}</span>
            <span className="text-green-600">+{change.additions}</span>
            <span className="text-red-600">-{change.deletions}</span>
          </div>
          <ul className="border-t border-gray-200 divide-y divide-gray-100">
            {change.files.map((file) => (
              <li key={file.id}>
                <button type="button" onClick={() => setOpenId(openId === file.id ? null : file.id)} className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-white">
                  <span className={`w-4 text-center font-bold ${file.changeType === 'added' ? 'text-green-600' : file.changeType === 'deleted' ? 'text-red-600' : 'text-amber-600'}`}>{file.changeType === 'added' ? 'A' : file.changeType === 'deleted' ? 'D' : 'M'}</span>
                  <span className="font-mono truncate flex-1">{file.path}</span>
                  <span className="text-gray-400">+{file.additions} -{file.deletions}</span>
                </button>
                {openId === file.id && (
                  <pre className="max-h-72 overflow-auto px-3 py-2 bg-white font-mono text-[11px] leading-relaxed">
                    {file.binary ? t('rooms.workspace.binary') : file.patch.split('\n').map((line, index) => (
                      <div key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-green-700 bg-green-50' : line.startsWith('-') && !line.startsWith('---') ? 'text-red-700 bg-red-50' : 'text-gray-600'}>{line || ' '}</div>
                    ))}
                    {file.truncated && <div className="text-gray-400">{t('rooms.workspace.truncated')}</div>}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
