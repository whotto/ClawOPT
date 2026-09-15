// 文件管理器（系统区）：按根浏览（Agent 工作区 / 额外根 / SSH / Docker），面包屑、git 标注、文本编辑（版本号 + 未保存拦截）、
// 可续传分块上传、改名 / 复制 / 删除 / 新建目录；Agent 工作区文件的预览复用聊天里的预览弹窗（只读引用）。
// member 只看得见自己 Agent 的工作区且只读；额外根、远端连接与主机密钥是 super_admin 的。
// 未保存拦截：页面内切文件 / 切目录 / 切根 / 关编辑器时确认；关页或刷新走 beforeunload。
// 已知缺口：侧栏切到别的设置页签由壳层路由完成，BrowserRouter 没有 useBlocker，拦不住（报告里记 TODO）。
import { ChevronRight, FolderPlus, HardDrive, RefreshCw, Settings2, Upload } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fileManagerApi } from '../../api/fileManager';
import { useAccess } from '../../app/access';
import { Badge, Button, Card, ConfirmDialog, ErrorBanner, inputClass, labelClass, LoadingRow, Modal, NoPermissionState, Notice, PageIntro, type ErrorDisplay } from '../../components/control/ControlUi';
import { HostFeatureNotice } from '../../components/control/HostFeatureNotice';
import { EntryTable } from '../../features/fileManager/components/EntryTable';
import { FileEditorPanel, type EditorFile } from '../../features/fileManager/components/FileEditorPanel';
import { FileManagerAdminPanel } from '../../features/fileManager/components/FileManagerAdminPanel';
import { UploadList } from '../../features/fileManager/components/UploadList';
import { baseName, breadcrumbs, groupRoots, isValidEntryName, joinPath, parentPath, type FileEntry, type ListResult, type RootView } from '../../features/fileManager/lib/fileManagerLogic';
import { useChunkedUploads } from '../../features/fileManager/useChunkedUploads';
import { readApi, useErrorDisplay } from '../control/useControlApi';

const FilePreviewModal = lazy(() => import('../../features/files/FilePreviewModal'));

type NameDialog = { mode: 'rename' | 'copy' | 'mkdir'; entry: FileEntry | null; value: string };
type Pending = { run: () => void } | null;

export default function FileManagerPage() {
  const { t } = useTranslation();
  const errors = useErrorDisplay();
  const { user } = useAccess();
  const isSuperAdmin = !user || user.role === 'super_admin';
  const [roots, setRoots] = useState<RootView[] | null>(null);
  const [rootId, setRootId] = useState('');
  const [dir, setDir] = useState('');
  const [listing, setListing] = useState<ListResult | null>(null);
  const [listError, setListError] = useState<ErrorDisplay | null>(null);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<EditorFile | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [deleting, setDeleting] = useState<FileEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [unsavedPrompt, setUnsavedPrompt] = useState<Pending>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const dirty = editor !== null && draft !== editor.content;
  const root = useMemo(() => roots?.find((entry) => entry.id === rootId) ?? null, [roots, rootId]);

  /** 有未保存内容时先确认，确认后才执行。 */
  const guard = useCallback((run: () => void) => {
    if (dirty) setUnsavedPrompt({ run });
    else run();
  }, [dirty]);

  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const loadRoots = useCallback(async () => {
    try {
      const result = await readApi<{ roots: RootView[] }>(fileManagerApi.roots());
      if (result.status === 403) {
        setForbidden(true);
        return;
      }
      if (!result.ok) {
        setRoots([]);
        setError(errors.fromResult(result, 'fileManager.page.loadFailed'));
        return;
      }
      setRoots(result.data.roots);
      setRootId((current) => (result.data.roots.some((entry) => entry.id === current) ? current : result.data.roots.find((entry) => entry.available)?.id ?? result.data.roots[0]?.id ?? ''));
    } catch (exception) {
      setRoots([]);
      setError(errors.fromException(exception));
    }
  }, [errors]);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const loadList = useCallback(async (targetRoot: string, targetDir: string) => {
    if (!targetRoot) return;
    setLoading(true);
    setListError(null);
    try {
      const result = await readApi<ListResult>(fileManagerApi.list(targetRoot, targetDir));
      if (result.ok) setListing(result.data);
      else {
        setListing(null);
        setListError(errors.fromResult(result, 'fileManager.page.loadFailed'));
      }
    } catch (exception) {
      setListing(null);
      setListError(errors.fromException(exception));
    } finally {
      setLoading(false);
    }
  }, [errors]);

  useEffect(() => {
    if (root?.available) void loadList(rootId, dir);
    else setListing(null);
  }, [root, rootId, dir, loadList]);

  const uploads = useChunkedUploads(useCallback((doneRoot: string, doneDir: string) => {
    if (doneRoot === rootId && doneDir === dir) void loadList(rootId, dir);
  }, [rootId, dir, loadList]));

  const closeEditor = () => {
    setEditor(null);
    setDraft('');
    setConflict(false);
    setSaved(false);
  };

  const openFile = async (entry: FileEntry) => {
    setError(null);
    try {
      const result = await readApi<{ file: EditorFile }>(fileManagerApi.read(rootId, entry.path));
      if (!result.ok) {
        setError(errors.fromResult(result, 'fileManager.page.openFailed'));
        return;
      }
      setEditor(result.data.file);
      setDraft(result.data.file.content);
      setConflict(false);
      setSaved(false);
    } catch (exception) {
      setError(errors.fromException(exception));
    }
  };

  const onOpen = (entry: FileEntry) => guard(() => {
    if (entry.kind === 'dir') {
      closeEditor();
      setDir(entry.path);
    } else void openFile(entry);
  });

  const changeRoot = (next: string) => guard(() => {
    closeEditor();
    setRootId(next);
    setDir('');
  });

  const changeDir = (next: string) => guard(() => {
    closeEditor();
    setDir(next);
  });

  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setSaved(false);
    try {
      const result = await readApi<{ revision: string }>(fileManagerApi.write(rootId, editor.path, draft, editor.revision));
      if (result.status === 412) {
        setConflict(true);
        return;
      }
      if (!result.ok) {
        setError(errors.fromResult(result, 'fileManager.page.saveFailed'));
        return;
      }
      setEditor({ ...editor, content: draft, revision: result.data.revision, size: new TextEncoder().encode(draft).length });
      setSaved(true);
      void loadList(rootId, dir);
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setSaving(false);
    }
  };

  const reloadEditor = () => {
    if (editor) void openFile({ name: baseName(editor.path), path: editor.path, kind: 'file', size: 0, mtimeMs: 0, git: null });
  };

  const runNameDialog = async () => {
    if (!nameDialog || !isValidEntryName(nameDialog.value)) return;
    setBusy(true);
    setError(null);
    try {
      const name = nameDialog.value.trim();
      const request = nameDialog.mode === 'mkdir'
        ? fileManagerApi.mkdir(rootId, joinPath(dir, name))
        : nameDialog.mode === 'rename'
          ? fileManagerApi.rename(rootId, nameDialog.entry!.path, joinPath(parentPath(nameDialog.entry!.path), name))
          : fileManagerApi.copy(rootId, nameDialog.entry!.path, joinPath(parentPath(nameDialog.entry!.path), name));
      const result = await readApi(request);
      if (!result.ok) {
        setError(errors.fromResult(result, 'fileManager.page.actionFailed'));
        return;
      }
      if (nameDialog.mode === 'rename' && editor?.path === nameDialog.entry?.path) closeEditor();
      setNameDialog(null);
      void loadList(rootId, dir);
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const result = await readApi(fileManagerApi.remove(rootId, deleting.path, deleting.kind === 'dir'));
      if (!result.ok) setError(errors.fromResult(result, 'fileManager.page.actionFailed'));
      else {
        if (editor && (editor.path === deleting.path || editor.path.startsWith(`${deleting.path}/`))) closeEditor();
        void loadList(rootId, dir);
      }
    } catch (exception) {
      setError(errors.fromException(exception));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const openPreview = async (entry: FileEntry) => {
    try {
      const result = await readApi<{ url: string; name: string }>(fileManagerApi.previewLink(rootId, entry.path));
      if (result.ok) setPreview({ url: result.data.url, name: result.data.name || entry.name });
      else setError(errors.fromResult(result, 'fileManager.page.previewFailed'));
    } catch (exception) {
      setError(errors.fromException(exception));
    }
  };

  if (forbidden) return <NoPermissionState />;

  const writable = Boolean(root?.writable);
  const gitState = listing?.git.state;

  return (
    <div className="space-y-6">
      <PageIntro
        title={t('fileManager.page.title')}
        description={t('fileManager.page.description')}
        actions={isSuperAdmin ? <Button onClick={() => setShowAdmin((value) => !value)}><Settings2 className="w-4 h-4" />{showAdmin ? t('fileManager.page.hideAdmin') : t('fileManager.page.showAdmin')}</Button> : undefined}
      />
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {showAdmin && isSuperAdmin && <FileManagerAdminPanel onChanged={() => void loadRoots()} />}

      {roots === null ? <LoadingRow /> : roots.length === 0 ? <Notice tone="blue">{t('fileManager.page.noRoots')}</Notice> : (
        <>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <label className="block sm:w-80">
              <span className={labelClass}>{t('fileManager.page.root')}</span>
              <select value={rootId} onChange={(event) => changeRoot(event.target.value)} className={inputClass} data-testid="file-manager-root">
                {groupRoots(roots).map((group) => (
                  <optgroup key={group.group} label={t(`fileManager.page.group.${group.group}`)}>
                    {group.roots.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{entry.available ? '' : ` (${t('hostFeature.unavailableTitle')})`}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void loadList(rootId, dir)} busy={loading} disabled={!root?.available}><RefreshCw className="w-4 h-4" />{t('control.common.refresh')}</Button>
              {writable && (
                <>
                  <Button onClick={() => setNameDialog({ mode: 'mkdir', entry: null, value: '' })} disabled={!root?.available}><FolderPlus className="w-4 h-4" />{t('fileManager.page.newFolder')}</Button>
                  <Button variant="primary" onClick={() => fileInput.current?.click()} disabled={!root?.available}><Upload className="w-4 h-4" />{t('fileManager.page.upload')}</Button>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = [...(event.target.files ?? [])];
                      if (files.length) uploads.enqueue(files, rootId, dir);
                      event.target.value = '';
                    }}
                  />
                </>
              )}
            </div>
          </div>

          {root && !root.available && <HostFeatureNotice reasonCode={root.reasonCode} onRefresh={() => void loadRoots()} />}
          {root && !writable && root.available && <Notice tone="blue">{t('fileManager.page.readOnlyRoot')}</Notice>}
          <UploadList items={uploads.items} onResume={uploads.resume} onDiscard={uploads.discard} />

          {root?.available && (
            <div className={`grid gap-4 ${editor ? 'xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]' : ''}`}>
              <Card className="overflow-hidden min-w-0">
                <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1 text-sm overflow-x-auto">
                  <button type="button" onClick={() => changeDir('')} className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-900 shrink-0">
                    <HardDrive className="w-4 h-4" />
                    <span className="max-w-[10rem] truncate">{root.label}</span>
                  </button>
                  {breadcrumbs(dir).map((crumb) => (
                    <span key={crumb.path} className="inline-flex items-center gap-1 shrink-0">
                      <ChevronRight className="w-3.5 h-3.5 text-gray-300" />
                      <button type="button" onClick={() => changeDir(crumb.path)} className="font-mono text-gray-600 hover:text-gray-900">{crumb.label}</button>
                    </span>
                  ))}
                  <div className="flex-1" />
                  {gitState && gitState !== 'ok' && gitState !== 'unsupported' && gitState !== 'notRepo' && <Badge tone="gray">{t(`fileManager.page.gitState.${gitState}`)}</Badge>}
                  {gitState === 'ok' && <Badge tone="green">git</Badge>}
                </div>
                {listError ? <div className="p-3"><ErrorBanner error={listError} /></div> : !listing ? <LoadingRow /> : (
                  <EntryTable
                    entries={listing.entries}
                    activePath={editor?.path ?? null}
                    writable={writable}
                    canPreview={root.kind === 'agent'}
                    downloadUrl={(entry) => fileManagerApi.downloadUrl(rootId, entry.path)}
                    onOpen={onOpen}
                    onPreview={(entry) => void openPreview(entry)}
                    onRename={(entry) => setNameDialog({ mode: 'rename', entry, value: entry.name })}
                    onCopy={(entry) => setNameDialog({ mode: 'copy', entry, value: `${entry.name}.copy` })}
                    onDelete={(entry) => setDeleting(entry)}
                  />
                )}
              </Card>
              {editor && (
                <FileEditorPanel
                  file={{ ...editor, writable: editor.writable && writable }}
                  draft={draft}
                  onDraftChange={(value) => { setDraft(value); setSaved(false); }}
                  saving={saving}
                  saved={saved}
                  conflict={conflict}
                  onSave={() => void save()}
                  onReset={() => setDraft(editor.content)}
                  onReload={reloadEditor}
                  onClose={() => guard(closeEditor)}
                />
              )}
            </div>
          )}
        </>
      )}

      {nameDialog && (
        <Modal
          title={t(`fileManager.page.dialog.${nameDialog.mode}`)}
          onClose={() => setNameDialog(null)}
          width="max-w-md"
          footer={(
            <>
              <Button onClick={() => setNameDialog(null)}>{t('common.cancel')}</Button>
              <Button variant="primary" busy={busy} disabled={!isValidEntryName(nameDialog.value)} onClick={() => void runNameDialog()}>{t('common.save')}</Button>
            </>
          )}
        >
          <label className="block">
            <span className={labelClass}>{t('fileManager.page.dialog.name')}</span>
            <input
              autoFocus
              className={`${inputClass} font-mono`}
              value={nameDialog.value}
              onChange={(event) => setNameDialog({ ...nameDialog, value: event.target.value })}
              onKeyDown={(event) => { if (event.key === 'Enter') void runNameDialog(); }}
            />
          </label>
          {!isValidEntryName(nameDialog.value) && nameDialog.value && <div className="text-xs text-red-600">{t('fileManager.page.dialog.invalidName')}</div>}
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('fileManager.actions.delete')}
          message={t(deleting.kind === 'dir' ? 'fileManager.page.confirmDeleteDir' : 'fileManager.page.confirmDeleteFile', { path: deleting.path })}
          confirmLabel={t('fileManager.actions.delete')}
          busy={busy}
          onConfirm={() => void runDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}

      {unsavedPrompt && (
        <ConfirmDialog
          title={t('fileManager.editor.unsavedTitle')}
          message={t('fileManager.editor.unsavedMessage')}
          confirmLabel={t('fileManager.editor.discard')}
          onConfirm={() => { const { run } = unsavedPrompt; setUnsavedPrompt(null); closeEditor(); run(); }}
          onCancel={() => setUnsavedPrompt(null)}
        />
      )}

      {preview && (
        <Suspense fallback={null}>
          <FilePreviewModal url={preview.url} filename={preview.name} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </div>
  );
}
