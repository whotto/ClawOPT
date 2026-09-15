// 聊天页的全部 state / ref 与只依赖它们的派生值。state 集中在这一处，后续各 hook 通过上下文对象读写，保证只有一份。
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeLanguage } from '../../../i18n';
import { readChatHistoryPageRounds } from '../../../utils/historyPagination';
import { getGroupIdValidationKey } from '../../../utils/groupId';
import type { ChatMessage } from '../../../utils/message-merge';
import {
  HISTORY_FETCH_BATCH_MIN_LIMIT, type HistoryPageInfo, type HistoryPageSnapshot,
  createEmptyHistoryPageInfo, buildLinearHistoryWindowSnapshot,
} from '../../../utils/history-window';
import type {
  NavDot, HistoryPagingDirection, HistoryPageNotice, SearchMatch, GroupRunState, GroupChat,
  GroupMember, GroupChatMember, ChatViewProps,
} from '../lib/types';

export function useChatViewState(props: ChatViewProps) {
  const { t, i18n } = useTranslation();
  const { mode, onMenuClick, sessions } = props;
  const isChat = mode === 'chat';
  const isGroup = mode === 'group';
  const activeKey = isChat ? (props.activeSessionId || '') : (props.activeGroupId || '');
  const currentLocale = normalizeLanguage(i18n.resolvedLanguage || i18n.language);

  // ---- Shared State ----
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // 发送/上传/加载失败时说人话。此前这些路径只把输入退回输入框、
  // 或者 catch {} 了事——用户看到消息弹回来却不知道为什么，只能反复重试。
  const [submitError, setSubmitError] = useState('');
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editExistingAttachments, setEditExistingAttachments] = useState<any[]>([]);
  const [editPendingFiles, setEditPendingFiles] = useState<any[]>([]);
  const [editIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [inputPreview, setInputPreview] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{file: File, preview: string}[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [previewFile, setPreviewFile] = useState<{url: string, filename: string} | null>(null);
  const [quotedMessage, setQuotedMessage] = useState<ChatMessage | null>(null);
  const [activeHighlightId, setActiveHighlightId] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [messageToDelete, setMessageToDelete] = useState<string | null>(null);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState('');
  const [fileErrorModalOpen, setFileErrorModalOpen] = useState(false);
  const [fileErrorMessage, setFileErrorMessage] = useState('');
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [historyPageRounds, setHistoryPageRounds] = useState(() => readChatHistoryPageRounds());
  const [historyEdgePrompt, setHistoryEdgePrompt] = useState<HistoryPagingDirection | null>(null);
  const [historyPageNotice, setHistoryPageNotice] = useState<HistoryPageNotice | null>(null);
  const [pageInfo, setPageInfo] = useState<HistoryPageInfo>(() => (
    createEmptyHistoryPageInfo(Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, readChatHistoryPageRounds() * 2))
  ));

  // Search
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [debouncedMessageSearchQuery, setDebouncedMessageSearchQuery] = useState('');
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
  const matchedMessageIdSet = useMemo(
    () => new Set(searchMatches.map((match) => match.messageId)),
    [searchMatches]
  );

  // Nav dots
  const [navDots, setNavDots] = useState<NavDot[]>([]);
  const [hoveredDot, setHoveredDot] = useState<string | null>(null);
  const [activeNavDot, setActiveNavDot] = useState<string | null>(null);

  // ---- Chat-mode State ----
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [showCommands, setShowCommands] = useState(false);
  const [allCommands, setAllCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [filteredCommands, setFilteredCommands] = useState<{ id: number; command: string; description: string }[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [aiName, setAiName] = useState('OpenClaw');
  const [characters, setCharacters] = useState<any[]>([]);

  // ---- Group-mode State ----
  const [groups, setGroups] = useState<GroupChat[]>([]);
  const [typingAgents, setTypingAgents] = useState<Map<string, string>>(new Map());
  const [groupRunState, setGroupRunState] = useState<GroupRunState>({ active: false, agentId: null, runId: null, startedAt: null });
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<GroupMember[]>([]);
  const [groupCreateError, setGroupCreateError] = useState<string | null>(null);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);

  // ---- Refs ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const attachedRunControllerRef = useRef<AbortController | null>(null);
  const justSelectedFileRef = useRef(false);
  const dragCounter = useRef(0);
  const isInitialLoad = useRef(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeLeafIdRef = useRef<string | null>(null);
  const pageInfoRef = useRef<HistoryPageInfo>(pageInfo);
  const lastAppliedHistoryPageRoundsRef = useRef(historyPageRounds);
  const historyContextRef = useRef('');
  const queuedMessagePatchesRef = useRef<Map<string, Partial<ChatMessage>>>(new Map());
  const queuedMessagePatchTimerRef = useRef<number | null>(null);
  const navScrollFrameRef = useRef<number | null>(null);
  const navDotPagingLockedRef = useRef(false);
  const navDotPagingUnlockTimerRef = useRef<number | null>(null);
  const historyEdgePromptReadyRef = useRef(false);
  const historyEdgePromptArmTimerRef = useRef<number | null>(null);
  const touchPagingStartYRef = useRef<number | null>(null);
  const touchPagingHandledRef = useRef(false);
  const touchPagingArmedInCurrentGestureRef = useRef(false);
  const historyPageNoticeTimerRef = useRef<number | null>(null);
  const activeHighlightTimerRef = useRef<number | null>(null);
  const pendingSearchFocusMessageIdRef = useRef<string | null>(null);
  const searchRequestIdRef = useRef(0);
  const searchNavigationIdRef = useRef(0);
  const olderLoadInFlightRef = useRef(false);
  const staleGroupReloadAttemptRef = useRef<string | null>(null);
  const previousGroupRunActiveRef = useRef(false);
  const groupSseRecoveryAtRef = useRef(0);
  const newerHistoryPagesRef = useRef<HistoryPageSnapshot[]>([]);
  const historyWindowScrollTargetRef = useRef<'top' | 'bottom' | null>(null);
  const historyWindowScrollLockRef = useRef(false);
  const historyWindowPagingGuardRef = useRef({ allowOlder: true, allowNewer: true });
  const skipNextAutoScrollRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const forceAutoScrollRef = useRef(false);
  const wasChatLoadingRef = useRef(false);
  const wasGroupBusyRef = useRef(false);

  useEffect(() => {
    return () => {
      attachedRunControllerRef.current?.abort();
      attachedRunControllerRef.current = null;
      if (activeHighlightTimerRef.current !== null) {
        window.clearTimeout(activeHighlightTimerRef.current);
        activeHighlightTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    previousGroupRunActiveRef.current = false;
  }, [activeKey, mode]);

  messagesRef.current = messages;
  activeLeafIdRef.current = activeLeafId;
  pageInfoRef.current = pageInfo;
  historyContextRef.current = `${mode}:${activeKey}`;

  // ---- Derived State ----
  const currentGroup = isGroup ? (groups.find(g => g.id === activeKey) || null) : null;
  const currentSession = isChat ? (sessions.find(s => s.id === activeKey) || null) : null;
  const groupIdErrorKey = getGroupIdValidationKey(
    newGroupId,
    groups.map((group) => group.id),
    { requireValue: true }
  );
  const groupIdError = groupIdErrorKey
    ? String(t(groupIdErrorKey, { groupId: newGroupId.trim() }))
    : null;
  const visibleGroupIdError = groupIdErrorKey && groupIdErrorKey !== 'groups.idRequired'
    ? groupIdError
    : null;
  const activeSessionName = currentSession?.name || aiName || t('unifiedChat.untitledRole');
  const findSessionByAgentId = useCallback((agentId?: string) => {
    if (!agentId) return null;
    return sessions.find(s => (s.agentId || s.id) === agentId) || null;
  }, [sessions]);
  const resolveGroupMemberDisplayName = useCallback((member: Pick<GroupChatMember, 'agent_id' | 'display_name'> | GroupMember) => {
    const agentId = 'agent_id' in member ? member.agent_id : member.agentId;
    const fallbackName = 'display_name' in member ? member.display_name : member.displayName;
    return findSessionByAgentId(agentId)?.name || fallbackName || agentId;
  }, [findSessionByAgentId]);
  const hasDraftToSend = Boolean(input.trim() || pendingFiles.length > 0 || quotedMessage);

  const getPreferredLeafId = useCallback((nextMessages: ChatMessage[]) => {
    if (nextMessages.length === 0) return null;
    return nextMessages[nextMessages.length - 1]?.id ?? null;
  }, []);

  const countVisibleUserRounds = useCallback((nextMessages: ChatMessage[]) => {
    return nextMessages.filter((message) => message.role === 'user').length;
  }, []);

  const getCurrentHistoryWindowSnapshot = useCallback((
    nextMessages: ChatMessage[],
    _nextLeafId: string | null,
    currentPageInfo: HistoryPageInfo = pageInfoRef.current,
  ) => (
    buildLinearHistoryWindowSnapshot(
      nextMessages,
      currentPageInfo,
      historyPageRounds,
      getPreferredLeafId,
    )
  ), [getPreferredLeafId, historyPageRounds]);

  const historyFetchBatchLimit = useMemo(() => (
    Math.min(200, Math.max(HISTORY_FETCH_BATCH_MIN_LIMIT, historyPageRounds * 2))
  ), [historyPageRounds]);

  return {
    props, t, i18n, mode, onMenuClick, sessions, isChat, isGroup, activeKey, currentLocale,
    messages, setMessages, input, setInput, isLoading, setIsLoading, submitError, setSubmitError,
    activeLeafId, setActiveLeafId, editingMessageId, setEditingMessageId, editContent,
    setEditContent, editExistingAttachments, setEditExistingAttachments, editPendingFiles,
    setEditPendingFiles, editIsDragging, copiedId, setCopiedId, inputPreview, setInputPreview,
    pendingFiles, setPendingFiles, isDragging, setIsDragging, previewFile, setPreviewFile,
    quotedMessage, setQuotedMessage, activeHighlightId, setActiveHighlightId, isDeleteModalOpen,
    setIsDeleteModalOpen, messageToDelete, setMessageToDelete, deleteErrorMessage,
    setDeleteErrorMessage, fileErrorModalOpen, setFileErrorModalOpen, fileErrorMessage,
    setFileErrorMessage, isInitialLoading, setIsInitialLoading, isLoadingOlder, setIsLoadingOlder,
    historyPageRounds, setHistoryPageRounds, historyEdgePrompt, setHistoryEdgePrompt,
    historyPageNotice, setHistoryPageNotice, pageInfo, setPageInfo, showMobileSearch,
    setShowMobileSearch, messageSearchQuery, setMessageSearchQuery, debouncedMessageSearchQuery,
    setDebouncedMessageSearchQuery, searchMatches, setSearchMatches, currentMatchIndex,
    setCurrentMatchIndex, matchedMessageIdSet, navDots, setNavDots, hoveredDot, setHoveredDot,
    activeNavDot, setActiveNavDot, currentModel, setCurrentModel, showCommands, setShowCommands,
    allCommands, setAllCommands, filteredCommands, setFilteredCommands, commandIndex,
    setCommandIndex, aiName, setAiName, characters, setCharacters, groups, setGroups, typingAgents,
    setTypingAgents, groupRunState, setGroupRunState, showCreateDialog, setShowCreateDialog,
    newGroupId, setNewGroupId, newGroupName, setNewGroupName, newGroupDesc, setNewGroupDesc,
    selectedMembers, setSelectedMembers, groupCreateError, setGroupCreateError, showMentionPopup,
    setShowMentionPopup, mentionFilter, setMentionFilter, mentionIndex, setMentionIndex,
    fileInputRef, messagesEndRef, textareaRef, scrollContainerRef, commandListRef,
    abortControllerRef, attachedRunControllerRef, justSelectedFileRef, dragCounter, isInitialLoad,
    eventSourceRef, messagesRef, activeLeafIdRef, pageInfoRef, lastAppliedHistoryPageRoundsRef,
    historyContextRef, queuedMessagePatchesRef, queuedMessagePatchTimerRef, navScrollFrameRef,
    navDotPagingLockedRef, navDotPagingUnlockTimerRef, historyEdgePromptReadyRef,
    historyEdgePromptArmTimerRef, touchPagingStartYRef, touchPagingHandledRef,
    touchPagingArmedInCurrentGestureRef, historyPageNoticeTimerRef, activeHighlightTimerRef,
    pendingSearchFocusMessageIdRef, searchRequestIdRef, searchNavigationIdRef,
    olderLoadInFlightRef, staleGroupReloadAttemptRef, previousGroupRunActiveRef,
    groupSseRecoveryAtRef, newerHistoryPagesRef, historyWindowScrollTargetRef,
    historyWindowScrollLockRef, historyWindowPagingGuardRef, skipNextAutoScrollRef,
    isNearBottomRef, forceAutoScrollRef, wasChatLoadingRef, wasGroupBusyRef, currentGroup,
    currentSession, groupIdErrorKey, groupIdError, visibleGroupIdError, activeSessionName,
    findSessionByAgentId, resolveGroupMemberDisplayName, hasDraftToSend, getPreferredLeafId,
    countVisibleUserRounds, getCurrentHistoryWindowSnapshot, historyFetchBatchLimit,
  };
}

export type ChatViewState = ReturnType<typeof useChatViewState>;
