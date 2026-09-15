// 单聊头部的对话标题（自动 / 运行时 / 手动，手动永远赢）、就地改名、导出（JSON / Markdown）、分叉（只对能分叉原生会话的运行时）
// 与「分叉自 …」血缘链接。
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, Download, GitBranch, MoreHorizontal, Pencil, X } from 'lucide-react';
import { useAccess } from '../../app/access';
import { forkSession, sessionExportUrl } from '../../api/sessions';
import { useSessionOrgStore } from './sessionOrgStore';
import { useRuntimeCapabilityStore } from './runtimeCapabilityStore';

export function ConversationTitleBar({ sessionId, externalRuntime, sessionName, isLoading, onForked, onError }: {
  sessionId: string;
  /** 一轮结束（true → false）时重拉组织视图：第一条消息的自动标题、运行时提议的标题这时才有。 */
  isLoading: boolean;
  externalRuntime: string | null;
  sessionName: (id: string) => string | null;
  onForked: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canManage = useAccess().can('agents.manage');
  const { organization, load, renameTitle } = useSessionOrgStore();
  const { runtimes, ensureLoaded } = useRuntimeCapabilityStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forking, setForking] = useState(false);

  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);
  useEffect(() => { if (!organization) void load(); }, [load, organization]);
  useEffect(() => { setEditing(null); setMenuOpen(false); }, [sessionId]);
  const [wasLoading, setWasLoading] = useState(isLoading);
  useEffect(() => {
    if (wasLoading && !isLoading) void load();
    setWasLoading(isLoading);
  }, [isLoading, load, wasLoading]);

  const info = organization?.sessions[sessionId];
  const canFork = canManage && !!externalRuntime && runtimes[externalRuntime]?.nativeFork === true;
  const parentName = info?.parentSessionId ? (sessionName(info.parentSessionId) ?? info.parentSessionId) : null;

  const saveTitle = async () => {
    if (editing === null) return;
    const title = editing.replace(/\s+/g, ' ').trim();
    if (!title) { setEditing(null); return; }
    const result = await renameTitle(sessionId, title);
    if (result.ok) setEditing(null);
    else onError(String(t('sessionOrg.errors.titleInvalid')));
  };

  const runFork = async () => {
    setMenuOpen(false);
    setForking(true);
    try {
      const response = await forkSession(sessionId);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.session?.id) {
        const code = payload?.errorCode;
        const translated = code ? t(code) : '';
        onError(translated && translated !== code ? String(translated) : String(t('sessionOrg.forkFailed')));
        return;
      }
      await onForked();
      await load();
      navigate(`/chat/${encodeURIComponent(payload.session.id)}`);
    } finally {
      setForking(false);
    }
  };

  return (
    <div className="relative flex min-w-0 items-center gap-1 text-xs text-gray-500" data-testid="conversation-title-bar">
      {editing !== null ? (
        <form className="flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void saveTitle(); }}>
          <input
            autoFocus
            value={editing}
            maxLength={120}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); }}
            className="w-40 sm:w-64 rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-800 focus:border-blue-500 focus:outline-none"
            aria-label={t('sessionOrg.titleLabel')}
          />
          <button type="submit" className="rounded p-0.5 hover:bg-gray-100" aria-label={t('common.save')}><Check className="h-3.5 w-3.5 text-blue-600" /></button>
          <button type="button" className="rounded p-0.5 hover:bg-gray-100" onClick={() => setEditing(null)} aria-label={t('common.cancel')}><X className="h-3.5 w-3.5" /></button>
        </form>
      ) : (
        <button
          type="button"
          className="group/title flex min-w-0 items-center gap-1 rounded px-1 hover:bg-gray-100"
          onClick={() => setEditing(info?.title ?? '')}
          title={info?.titleSource ? t(`sessionOrg.titleSource.${info.titleSource}`) : t('sessionOrg.renameTitle')}
        >
          <span className="truncate max-w-[9rem] sm:max-w-[16rem]">{info?.title || t('sessionOrg.untitled')}</span>
          <Pencil className="h-3 w-3 shrink-0 opacity-60 group-hover/title:opacity-100" />
        </button>
      )}
      {parentName && info?.parentSessionId && (
        <button
          type="button"
          className="hidden sm:flex items-center gap-1 rounded px-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          onClick={() => navigate(`/chat/${encodeURIComponent(info.parentSessionId!)}`)}
          data-testid="conversation-fork-lineage"
        >
          <GitBranch className="h-3 w-3" />
          <span className="truncate max-w-[8rem]">{t('sessionOrg.forkedFrom', { name: parentName })}</span>
        </button>
      )}
      <button type="button" className="rounded p-0.5 hover:bg-gray-100" onClick={() => setMenuOpen((value) => !value)} aria-label={t('sessionOrg.conversationMenu')} data-testid="conversation-menu">
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {menuOpen && (
        <div className="absolute left-0 top-full z-40 mt-1 w-48 rounded-xl border border-gray-200 bg-white py-1 text-sm text-gray-700">
          <a className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50" href={sessionExportUrl(sessionId, 'markdown')} download onClick={() => setMenuOpen(false)}>
            <Download className="h-3.5 w-3.5 text-gray-400" />{t('sessionOrg.exportMarkdown')}
          </a>
          <a className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50" href={sessionExportUrl(sessionId, 'json')} download onClick={() => setMenuOpen(false)}>
            <Download className="h-3.5 w-3.5 text-gray-400" />{t('sessionOrg.exportJson')}
          </a>
          {canFork && (
            <button type="button" disabled={forking} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-gray-50 disabled:opacity-50" onClick={() => void runFork()}>
              <GitBranch className="h-3.5 w-3.5 text-gray-400" />{t('sessionOrg.fork')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
