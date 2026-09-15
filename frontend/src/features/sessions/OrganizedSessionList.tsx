// 侧栏「智能体」页签的组织视图：置顶、Recent、分类、未分类、归档分组（可折叠），行菜单挪分类 / 归档，
// 整理面板（新建分类、Recent 数量、只看人建的），管理员的批量删除（部分失败逐个说明）。
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, FolderInput, MoreHorizontal, Pencil, Pin, PinOff, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useAccess } from '../../app/access';
import type { SidebarProps } from '../../app/sidebar/Sidebar';
import { SessionCard } from '../../app/sidebar/SidebarCards';
import {
  buildSessionSections, clampRecentCount, parseSessionOrgPrefs, summarizeBatchDelete,
  SESSION_ORG_PREFS_KEY, type SessionOrgPrefs, type SessionSection,
} from './sessionOrganization';
import { useSessionOrgStore } from './sessionOrgStore';

type SessionItem = SidebarProps['sessions'][number];

function readPrefs(): SessionOrgPrefs {
  try {
    return parseSessionOrgPrefs(window.localStorage.getItem(SESSION_ORG_PREFS_KEY));
  } catch {
    return parseSessionOrgPrefs(null);
  }
}

function writePrefs(prefs: SessionOrgPrefs): void {
  try {
    window.localStorage.setItem(SESSION_ORG_PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

export function OrganizedSessionList({ sidebar, onShowInfo, renderFlat }: {
  sidebar: SidebarProps;
  onShowInfo: (e: React.MouseEvent, session: { id: string; name: string }) => void;
  /** 没有任何组织（无分类、无归档、Recent 关、不筛选）时沿用原来的可拖拽平铺列表。 */
  renderFlat: (renderRowAction: (session: SessionItem) => React.ReactNode) => React.ReactNode;
}) {
  const { t } = useTranslation();
  const canManage = useAccess().can('agents.manage');
  const { organization, load, createCategory, renameCategory, deleteCategory, moveToCategory, setArchived, setPinned, batchDelete } = useSessionOrgStore();
  // 偏好只在用户操作时写（加载不写）。
  const [prefs, setPrefsState] = useState<SessionOrgPrefs>(() => readPrefs());
  const setPrefs = (next: SessionOrgPrefs) => { setPrefsState(next); writePrefs(next); };
  const [showSettings, setShowSettings] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  const sessionIdsKey = sidebar.sessions.map((s) => s.id).join(',');
  useEffect(() => { void load(); }, [load, sessionIdsKey]);

  const sections = useMemo(
    () => buildSessionSections<SessionItem>(sidebar.sessions, organization, { humanOnly: prefs.humanOnly, recentCount: prefs.recentCount, showRecent: prefs.showRecent }),
    [organization, prefs.humanOnly, prefs.recentCount, prefs.showRecent, sidebar.sessions],
  );
  // 有分类 / 归档 / 筛选 / 批量时整张列表按组渲染；否则 Recent（如有）加原来的可拖拽平铺列表。
  const organized = sections.some((section) => section.kind === 'category' || section.kind === 'archived') || prefs.humanOnly || batchMode;
  // 平铺模式下置顶组与 Recent 照样显示在拖拽列表上面（置顶的会话在平铺列表里仍然出现：那份顺序是拖拽排出来的，不拆）。
  const visibleSections = organized ? sections : sections.filter((section) => section.kind === 'recent' || section.kind === 'pinned');
  const nameOf = (id: string) => sidebar.sessions.find((s) => s.id === id)?.name || id;

  const reportFailure = (payload: any, fallbackKey: string) => {
    const code = payload?.errorCode;
    const translated = code ? t(code) : '';
    setNotice({ tone: 'error', text: translated && translated !== code ? String(translated) : String(t(fallbackKey)) });
  };

  const toggleCollapsed = (key: string) => {
    const collapsed = prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key];
    setPrefs({ ...prefs, collapsed });
  };

  const sectionTitle = (section: SessionSection<SessionItem>) => {
    if (section.kind === 'pinned') return t('sessionOrg.pinned');
    if (section.kind === 'recent') return t('sessionOrg.recent');
    if (section.kind === 'archived') return t('sessionOrg.archived');
    if (section.kind === 'uncategorized') return t('sessionOrg.uncategorized');
    return section.category.name;
  };

  const runBatchDelete = async () => {
    const ids = [...selected];
    const result = await batchDelete(ids);
    await sidebar.reloadSessions();
    const summary = summarizeBatchDelete(result.payload ?? {}, nameOf);
    setSelected(new Set());
    setConfirmDelete(false);
    if (summary.kind === 'ok') {
      setNotice({ tone: 'info', text: String(t('sessionOrg.batchDeleted', { count: summary.deleted })) });
      setBatchMode(false);
    } else {
      setNotice({ tone: 'error', text: String(t(summary.kind === 'partial' ? 'sessionOrg.batchPartial' : 'sessionOrg.batchFailed', { count: summary.deleted, names: summary.failedNames.join(', ') })) });
    }
  };

  /** 行菜单（挪分类 / 归档）：组视图与平铺拖拽列表共用。放在 `relative` 的行容器里。 */
  const renderRowMenu = (session: SessionItem, rowKey: string) => {
    const info = organization?.sessions[session.id];
    return (
      <>
        {!batchMode && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); setMenuFor(menuFor === rowKey ? null : rowKey); }}
            className="absolute right-10 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 opacity-100 hover:bg-gray-200 hover:text-gray-700 md:opacity-0 md:group-hover/row:opacity-100"
            title={t('sessionOrg.rowMenu')}
            aria-label={t('sessionOrg.rowMenu')}
            data-testid="session-org-row-menu"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
        {menuFor === rowKey && (
          <div className="absolute right-2 top-full z-30 mt-1 w-52 rounded-xl border border-gray-200 bg-white py-1 text-sm" onClick={(event) => event.stopPropagation()}>
            <div className="px-3 py-1 text-[11px] font-semibold text-gray-400">{t('sessionOrg.moveTo')}</div>
            {[{ id: null as number | null, name: String(t('sessionOrg.uncategorized')) }, ...(organization?.categories ?? [])].map((category) => (
              <button
                key={category.id ?? 'none'}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50"
                onClick={async () => {
                  setMenuFor(null);
                  const result = await moveToCategory(session.id, category.id);
                  if (!result.ok) reportFailure(result.payload, 'sessionOrg.actionFailed');
                }}
              >
                <FolderInput className="h-3.5 w-3.5 text-gray-400" />
                <span className="flex-1 truncate">{category.name}</span>
                {(info?.categoryId ?? null) === category.id && <Check className="h-3.5 w-3.5 text-blue-600" />}
              </button>
            ))}
            <div className="my-1 border-t border-gray-100" />
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50"
              data-testid="session-org-pin"
              onClick={async () => {
                setMenuFor(null);
                const result = await setPinned(session.id, !info?.pinnedAt);
                if (!result.ok) reportFailure(result.payload, 'sessionOrg.actionFailed');
              }}
            >
              {info?.pinnedAt ? <PinOff className="h-3.5 w-3.5 text-gray-400" /> : <Pin className="h-3.5 w-3.5 text-gray-400" />}
              {info?.pinnedAt ? t('sessionOrg.unpin') : t('sessionOrg.pin')}
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50"
              onClick={async () => {
                setMenuFor(null);
                const result = await setArchived(session.id, !info?.archived);
                if (!result.ok) reportFailure(result.payload, 'sessionOrg.actionFailed');
              }}
            >
              {info?.archived ? <ArchiveRestore className="h-3.5 w-3.5 text-gray-400" /> : <Archive className="h-3.5 w-3.5 text-gray-400" />}
              {info?.archived ? t('sessionOrg.unarchive') : t('sessionOrg.archive')}
            </button>
          </div>
        )}
      </>
    );
  };

  const renderRow = (session: SessionItem, section: SessionSection<SessionItem>) => {
    const rowKey = `${section.key}:${session.id}`;
    return (
      <div key={rowKey} className="relative flex items-center gap-1">
        {batchMode && (
          <input
            type="checkbox"
            className="ml-1 h-4 w-4 shrink-0 accent-blue-600"
            checked={selected.has(session.id)}
            onChange={() => setSelected((prev) => { const next = new Set(prev); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next; })}
            aria-label={t('sessionOrg.selectSession', { name: session.name })}
          />
        )}
        <div className="min-w-0 flex-1">
          <SessionCard s={session} sidebar={sidebar} onShowInfo={onShowInfo} />
        </div>
        {renderRowMenu(session, rowKey)}
      </div>
    );
  };

  return (
    <div className="space-y-2" data-testid="organized-session-list" onClick={() => setMenuFor(null)}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); setShowSettings((value) => !value); }}
          className={`flex h-7 items-center gap-1 rounded-lg px-2 text-xs ${showSettings ? 'bg-white text-gray-800 border border-gray-200' : 'text-gray-500 hover:bg-gray-200'}`}
          data-testid="session-org-settings-toggle"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('sessionOrg.organize')}
        </button>
        {prefs.humanOnly && <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-500">{t('sessionOrg.humanOnlyActive')}</span>}
        {canManage && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); setBatchMode((value) => !value); setSelected(new Set()); setConfirmDelete(false); }}
            className={`ml-auto flex h-7 items-center gap-1 rounded-lg px-2 text-xs ${batchMode ? 'bg-white text-gray-800 border border-gray-200' : 'text-gray-500 hover:bg-gray-200'}`}
          >
            {batchMode ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
            {batchMode ? t('sessionOrg.exitBatch') : t('sessionOrg.batch')}
          </button>
        )}
      </div>

      {showSettings && (
        <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-600" onClick={(event) => event.stopPropagation()}>
          <form
            className="flex gap-1"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!newCategory.trim()) return;
              const result = await createCategory(newCategory);
              if (result.ok) setNewCategory('');
              else reportFailure(result.payload, 'sessionOrg.actionFailed');
            }}
          >
            <input
              value={newCategory}
              onChange={(event) => setNewCategory(event.target.value)}
              maxLength={40}
              placeholder={t('sessionOrg.newCategoryPlaceholder')}
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
            />
            <button type="submit" className="rounded-lg bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-700">{t('sessionOrg.addCategory')}</button>
          </form>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-blue-600" checked={prefs.showRecent} onChange={(event) => setPrefs({ ...prefs, showRecent: event.target.checked })} />
            {t('sessionOrg.showRecent')}
            <input
              type="number"
              min={1}
              max={100}
              value={prefs.recentCount}
              onChange={(event) => setPrefs({ ...prefs, recentCount: clampRecentCount(event.target.value) })}
              className="ml-auto w-14 rounded-lg border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs"
              aria-label={t('sessionOrg.recentCount')}
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-blue-600" checked={prefs.humanOnly} onChange={(event) => setPrefs({ ...prefs, humanOnly: event.target.checked })} />
            {t('sessionOrg.humanOnly')}
          </label>
          <p className="text-[11px] text-gray-400">{t('sessionOrg.prefsHint')}</p>
        </div>
      )}

      {notice && (
        <div className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-[11px] ${notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-600' : 'border-gray-200 bg-white text-gray-600'}`}>
          <span className="flex-1 break-words">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t('common.close')}><X className="h-3 w-3" /></button>
        </div>
      )}

      {visibleSections.map((section) => {
        const collapsed = prefs.collapsed.includes(section.key);
        return (
          <div key={section.key}>
            <div className="group/section flex items-center gap-1 px-1 py-1 text-[11px] font-semibold text-gray-500">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-gray-700" onClick={(event) => { event.stopPropagation(); toggleCollapsed(section.key); }}>
                {collapsed ? <ChevronRight className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
                {renaming && section.kind === 'category' && renaming.id === section.category.id ? null : <span className="truncate">{sectionTitle(section)}</span>}
                <span className="text-gray-400">{section.items.length}</span>
              </button>
              {section.kind === 'category' && renaming?.id === section.category.id && (
                <form
                  className="flex flex-1 gap-1"
                  onClick={(event) => event.stopPropagation()}
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const result = await renameCategory(section.category.id, renaming.name);
                    if (result.ok) setRenaming(null);
                    else reportFailure(result.payload, 'sessionOrg.actionFailed');
                  }}
                >
                  <input autoFocus value={renaming.name} maxLength={40} onChange={(event) => setRenaming({ ...renaming, name: event.target.value })} className="min-w-0 flex-1 rounded border border-gray-200 px-1 text-[11px]" />
                  <button type="submit" aria-label={t('common.save')}><Check className="h-3.5 w-3.5 text-blue-600" /></button>
                  <button type="button" onClick={() => setRenaming(null)} aria-label={t('common.cancel')}><X className="h-3.5 w-3.5" /></button>
                </form>
              )}
              {section.kind === 'category' && !renaming && (
                <span className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover/section:opacity-100">
                  <button type="button" className="rounded p-0.5 hover:bg-gray-200" title={t('sessionOrg.renameCategory')} onClick={(event) => { event.stopPropagation(); setRenaming({ id: section.category.id, name: section.category.name }); }}>
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-red-50 hover:text-red-500"
                    title={t('sessionOrg.deleteCategory')}
                    onClick={async (event) => {
                      event.stopPropagation();
                      const result = await deleteCategory(section.category.id);
                      if (!result.ok) reportFailure(result.payload, 'sessionOrg.actionFailed');
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              )}
            </div>
            {!collapsed && (
              <div className="space-y-1 [&>div]:group/row">
                {section.items.length === 0
                  ? <p className="px-2 py-1 text-[11px] text-gray-400">{t('sidebar.noItems')}</p>
                  : section.items.map((session) => <div key={`${section.key}:${session.id}`} className="group/row">{renderRow(session, section)}</div>)}
              </div>
            )}
          </div>
        );
      })}

      {/* 平铺列表上面已经有置顶 / Recent 组时，给平铺列表一个标题：同一个会话出现两次时一眼看得出是「快捷入口 + 全部」而不是重复 */}
      {!organized && visibleSections.length > 0 && (
        <div className="px-1 pt-1 text-[11px] font-semibold text-gray-500" data-testid="session-org-all-label">{t('sessionOrg.allSessions')}</div>
      )}
      {!organized && renderFlat((session) => (organization ? renderRowMenu(session, `flat:${session.id}`) : null))}

      {batchMode && (
        <div className="sticky bottom-0 flex items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 text-xs">
          <span className="flex-1 text-gray-500">{t('sessionOrg.selectedCount', { count: selected.size })}</span>
          {confirmDelete ? (
            <>
              <button type="button" className="rounded-lg px-2 py-1 text-gray-500 hover:bg-gray-100" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</button>
              <button type="button" className="rounded-lg bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700" onClick={() => void runBatchDelete()}>{t('sessionOrg.confirmDelete', { count: selected.size })}</button>
            </>
          ) : (
            <button type="button" disabled={selected.size === 0} className="rounded-lg bg-red-100 px-2 py-1 font-semibold text-red-600 hover:bg-red-200 disabled:opacity-40" onClick={() => setConfirmDelete(true)}>
              {t('sessionOrg.deleteSelected')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
