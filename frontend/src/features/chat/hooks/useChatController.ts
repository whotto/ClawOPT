import type { ChatViewProps } from '../lib/types';
import { useChatViewState } from './useChatViewState';
import { useChatPresence } from './useChatPresence';
import { useMessagePatchQueue } from './useMessagePatchQueue';
import { useNavDots } from './useNavDots';
import { useHistoryEdgePrompt } from './useHistoryEdgePrompt';
import { useSearchQueryDebounce } from './useSearchQueryDebounce';
import { useHistoryScroll } from './useHistoryScroll';
import { useComposerEffects } from './useComposerEffects';
import { useHistoryPageRounds } from './useHistoryPageRounds';
import { useChatModeBootstrap } from './useChatModeBootstrap';
import { useChatHistoryFetch } from './useChatHistoryFetch';
import { useMessageSearch } from './useMessageSearch';
import { useHistoryPaging } from './useHistoryPaging';
import { useGlobalSearchFocus } from './useGlobalSearchFocus';
import { useChatAttachRun } from './useChatAttachRun';
import { useChatRunControl } from './useChatRunControl';
import { useGroupEvents } from './useGroupEvents';
import { useMessageActions } from './useMessageActions';
import { useComposerActions } from './useComposerActions';
import { useGroupManagement } from './useGroupManagement';
import { useWorkspaceChanges } from '../workspace/useWorkspaceChanges';

/**
 * 聊天页控制器：按原 UnifiedChatView 函数体的先后顺序依次调用各段 hook。
 *
 * 顺序不能调换——React 按调用顺序执行 effect，而这些 effect 之间有先后依赖
 * （例如切换会话时先重置滚动标记、再自动滚到底；先重置运行态记录、再做运行结束收敛）。
 * 每一段只读取排在它前面的段产出的值，所以上下文对象逐段累加。
 */
export function useChatController(props: ChatViewProps) {
  const state = useChatViewState(props);
  const c1 = { ...state, ...useChatPresence(state) };
  const c2 = { ...c1, ...useMessagePatchQueue(c1) };
  const c3 = { ...c2, ...useNavDots(c2) };
  const c4 = { ...c3, ...useHistoryEdgePrompt(c3) };
  useSearchQueryDebounce(c4);
  const c5 = { ...c4, ...useHistoryScroll(c4) };
  useComposerEffects(c5);
  const c6 = { ...c5, ...useHistoryPageRounds(c5) };
  const c7 = { ...c6, ...useChatModeBootstrap(c6) };
  const c8 = { ...c7, ...useChatHistoryFetch(c7) };
  const c9 = { ...c8, ...useMessageSearch(c8) };
  const c10 = { ...c9, ...useHistoryPaging(c9) };
  // 全局搜索（Ctrl/Cmd+K）交来的「跳到这条消息」：排在首屏加载之后，只读前面各段的值。
  useGlobalSearchFocus(c10);
  const cRun = { ...c10, ...useChatRunControl(c10) };
  useChatAttachRun(cRun);
  const c11 = { ...cRun, ...useGroupEvents(cRun) };
  const c12 = { ...c11, ...useMessageActions(c11) };
  const c13 = { ...c12, ...useComposerActions(c12) };
  const c14 = { ...c13, ...useGroupManagement(c13) };
  // 每次运行的工作区改动卡片与 diff 面板（只在单聊）。
  return { ...c14, ...useWorkspaceChanges({ enabled: c14.isChat, sessionId: c14.activeKey, messages: c14.messages, isLoading: c14.isLoading }) };
}

export type ChatController = ReturnType<typeof useChatController>;
