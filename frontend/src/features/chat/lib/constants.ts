// 聊天页的时序、阈值与样式常量（拆自 UnifiedChatView，数值原样保留）。

export const GROUP_MAX_CHAIN_DEPTH_MESSAGE_CODE = 'group.maxChainDepthReached';
export const STREAM_UPDATE_BATCH_MS = 40;
export const NAV_DOTS_MAX_VISIBLE = 40;
export const HISTORY_WINDOW_MAX_FETCH_BATCHES = 8;
export const HISTORY_LOAD_TRIGGER_PX = 72;
export const HISTORY_TOUCH_TRIGGER_PX = 28;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MATCH_HIGHLIGHT_DURATION_MS = 5000;
export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 160;
export const NAV_DOT_PAGING_UNLOCK_DEBOUNCE_MS = 180;
// SSE 才是主通道，这条轮询只是断流兜底。原来 500ms 一次，每次把整条正在生成的消息
// （正文 + 过程）整体序列化回传，2 万字回复时每秒 80KB，和 delta 事件完全重复。
export const GROUP_ACTIVE_RUN_RECOVERY_POLL_MS = 5000;
export const GROUP_SSE_RECOVERY_THROTTLE_MS = 2000;
export const GROUP_POST_RUN_SETTLE_POLL_MS = 2000;
export const GROUP_POST_RUN_SETTLE_TIMEOUT_MS = 120000;
export const CHAT_ACTIVE_RUN_RECOVERY_POLL_MS = 1500;
export const DEFAULT_PROCESS_START_TAG = '[执行工作_Start]';
export const DEFAULT_PROCESS_END_TAG = '[执行工作_End]';
export const MODAL_FORM_FONT_STYLE = {
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;
export const MODAL_FIELD_LABEL_CLASS = 'block text-sm font-semibold text-gray-700 mb-1.5';
export const MODAL_TEXT_INPUT_CLASS = 'w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
export const MODAL_TEXTAREA_CLASS = 'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all resize-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
