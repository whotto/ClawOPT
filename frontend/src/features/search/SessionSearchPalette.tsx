import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Loader2, MessageSquare, Search, X } from 'lucide-react';
import { searchChats, type ChatSearchResponse, type ChatSearchResult } from '../../api/search';
import {
  createRequestSequence,
  highlightSegments,
  moveSelection,
  requestChatFocus,
  splitSearchTerms,
} from './lib/searchLib';
import { shortcutLabel } from './lib/shortcuts';

const SEARCH_DEBOUNCE_MS = 160;
const RECENT_LIMIT = 8;
const RESULT_LIMIT = 10;

type ViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; mode: 'recent' | 'search'; terms: string[]; results: ChatSearchResult[] };

function formatTimestamp(value: string | null, locale: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/**
 * Ctrl/Cmd+K 会话搜索面板。空查询显示最近会话；输入后 160ms 去抖，按请求序号丢弃过期响应；
 * ↑/↓ 选择、Enter 打开、Esc 关闭（Esc 由壳层的全局快捷键处理，这里的输入框也兜一层）。
 * 打开消息命中时交给聊天页一个一次性的「跳到这条消息」请求。
 */
export default function SessionSearchPalette({ isMac, onClose, onOpenSession }: {
  isMac: boolean;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState(true);
  const sequence = useMemo(() => createRequestSequence(), []);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => sequence.invalidate();
  }, [sequence]);

  useEffect(() => {
    const trimmed = query.trim();
    const token = sequence.next();
    const controller = new AbortController();
    setPending(true);
    setView((current) => (current.status === 'ready' && trimmed ? current : { status: 'loading' }));
    const timer = window.setTimeout(async () => {
      try {
        const response = await searchChats(trimmed, { limit: trimmed ? RESULT_LIMIT : RECENT_LIMIT, signal: controller.signal });
        const data = await response.json() as ChatSearchResponse;
        if (!sequence.isCurrent(token)) return;
        setPending(false);
        if (!response.ok || !data?.success || !Array.isArray(data.results)) {
          setView({ status: 'error' });
          return;
        }
        setView({ status: 'ready', mode: data.mode, terms: Array.isArray(data.terms) ? data.terms : splitSearchTerms(trimmed), results: data.results });
        setSelected(data.results.length > 0 ? 0 : -1);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError' || !sequence.isCurrent(token)) return;
        setPending(false);
        setView({ status: 'error' });
      }
    }, trimmed ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, sequence]);

  const results = view.status === 'ready' ? view.results : [];

  const openResult = useCallback((result: ChatSearchResult | undefined) => {
    if (!result) return;
    if (typeof result.matchedMessageId === 'number') {
      requestChatFocus({ sessionId: result.sessionId, messageId: String(result.matchedMessageId), anchorBeforeId: result.anchorBeforeId ?? null });
    }
    onOpenSession(result.sessionId);
    onClose();
  }, [onClose, onOpenSession]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-search-index="${selected}"]`);
    item?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((current) => moveSelection(current, event.key === 'ArrowDown' ? 1 : -1, results.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openResult(results[selected]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const locale = i18n.resolvedLanguage || i18n.language || 'en';

  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label={t('sessionSearch.title')}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-xl bg-white rounded-2xl border border-gray-200 flex flex-col max-h-[70vh] overflow-hidden">
        <div className="flex items-center gap-2 px-4 border-b border-gray-100">
          <Search className="w-4 h-4 text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('sessionSearch.placeholder')}
            className="flex-1 min-w-0 py-3.5 bg-transparent text-[15px] text-gray-900 placeholder:text-gray-400 focus:outline-none"
            aria-label={t('sessionSearch.placeholder')}
            data-testid="session-search-input"
          />
          {pending && <Loader2 className="w-4 h-4 text-gray-400 animate-spin shrink-0" />}
          <button type="button" onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg shrink-0" title={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-2" data-testid="session-search-results">
          {view.status === 'ready' && results.length > 0 && (
            <div className="px-4 pb-1 pt-0.5 text-xs font-semibold text-gray-400">
              {view.mode === 'recent' ? t('sessionSearch.recent') : t('sessionSearch.results', { count: results.length })}
            </div>
          )}
          {view.status === 'error' && (
            <div className="px-4 py-8 text-sm text-center text-red-600">{t('sessionSearch.error')}</div>
          )}
          {view.status === 'loading' && results.length === 0 && (
            <div className="px-4 py-8 text-sm text-center text-gray-400">{t('sessionSearch.loading')}</div>
          )}
          {view.status === 'ready' && results.length === 0 && (
            <div className="px-4 py-8 text-sm text-center text-gray-400">
              {view.mode === 'recent' ? t('sessionSearch.noRecent') : t('sessionSearch.noResults')}
            </div>
          )}
          {results.map((result, index) => {
            const isSelected = index === selected;
            const terms = view.status === 'ready' ? view.terms : [];
            const snippet = result.matchedField === 'message' ? result.snippet ?? '' : '';
            return (
              <button
                key={`${result.sessionId}:${result.matchedMessageId ?? 'session'}`}
                type="button"
                data-search-index={index}
                onMouseEnter={() => setSelected(index)}
                onClick={() => openResult(result)}
                className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
              >
                <span className={`mt-0.5 shrink-0 ${isSelected ? 'text-blue-600' : 'text-gray-400'}`}>
                  {view.status === 'ready' && view.mode === 'recent' ? <Clock className="w-4 h-4" /> : <MessageSquare className="w-4 h-4" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={`text-sm font-semibold truncate ${isSelected ? 'text-blue-700' : 'text-gray-900'}`}>
                      {highlightSegments(result.sessionName, terms).map((segment, i) => (
                        segment.match ? <mark key={i} className="bg-amber-100 text-inherit rounded-sm">{segment.text}</mark> : <span key={i}>{segment.text}</span>
                      ))}
                    </span>
                    <span className="text-[11px] text-gray-400 shrink-0">{formatTimestamp(result.timestamp, locale)}</span>
                  </span>
                  {snippet && (
                    <span className="block mt-0.5 text-[13px] text-gray-500 break-words line-clamp-2">
                      {result.role === 'user' && <span className="text-gray-400">{t('sessionSearch.youPrefix')}</span>}
                      {highlightSegments(snippet, terms).map((segment, i) => (
                        segment.match ? <mark key={i} className="bg-amber-100 text-gray-800 rounded-sm">{segment.text}</mark> : <span key={i}>{segment.text}</span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-400">
          <span>{t('sessionSearch.hintNavigate')}</span>
          <span>{t('sessionSearch.hintOpen')}</span>
          <span>{t('sessionSearch.hintClose')}</span>
          <span className="ml-auto">{t('sessionSearch.hintShortcuts', { search: shortcutLabel('k', isMac), newChat: shortcutLabel('n', isMac), settings: shortcutLabel(',', isMac) })}</span>
        </div>
      </div>
    </div>
  );
}
