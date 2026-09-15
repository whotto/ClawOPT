import { lazy, Suspense } from 'react';
import { useChatController } from '../../features/chat/hooks/useChatController';
import type { ChatViewProps } from '../../features/chat/lib/types';
import { ChatHeader } from '../../features/chat/components/ChatHeader';
import ChatRunApprovals from '../../features/approvals/ChatRunApprovals';
import { Composer } from '../../features/chat/components/Composer';
import { DeleteMessageDialog } from '../../features/chat/components/DeleteMessageDialog';
import { DragOverlay } from '../../features/chat/components/DragOverlay';
import { FileErrorDialog } from '../../features/chat/components/FileErrorDialog';
import { GroupListPage } from '../../features/chat/components/GroupListPage';
import { HistoryPagingPrompts } from '../../features/chat/components/HistoryPagingPrompts';
import { MessageList } from '../../features/chat/components/MessageList';
import { NavDotsRail } from '../../features/chat/components/NavDotsRail';
import { RoomCollabLayer } from '../../features/rooms/RoomCollabLayer';

// 预览模块带着 mammoth / xlsx / pdfjs（合计约 1.5MB），只在真的打开预览时才下载。
const FilePreviewModal = lazy(() => import('../../features/files/FilePreviewModal'));

/**
 * 单聊 / 群聊页容器（拆自 UnifiedChatView）。状态与副作用全部在 useChatController，
 * 这里只负责布局；子组件都是无状态的展示层，拿到的值与拆分前同一次渲染里的值一致。
 */
export default function ChatView(props: ChatViewProps) {
  const c = useChatController(props);

  // ====== GROUP LIST VIEW (no active group) ======
  if (c.isGroup && !c.activeKey) {
    return <GroupListPage {...c} />;
  }

  // ====== ACTIVE CHAT VIEW (both modes) ======
  const showMessageListSkeleton = c.isInitialLoading;
  const showOlderHistorySkeleton = !showMessageListSkeleton && c.isLoadingOlder;
  const canShowHistoryPagingUi = !showMessageListSkeleton && c.messages.length > 0;

  return (
    <div className="flex flex-col h-full bg-white relative" onDragEnter={c.handleDrag} onDragOver={c.handleDrag} onDragLeave={c.handleDrag} onDrop={c.handleDrop}>
      <DragOverlay {...c} />

      <ChatHeader {...c} />

      {/* Message List Area */}
      <div className="flex-1 flex relative min-h-0">
        <NavDotsRail {...c} showMessageListSkeleton={showMessageListSkeleton} />
        <HistoryPagingPrompts {...c} canShowHistoryPagingUi={canShowHistoryPagingUi} />
        <MessageList {...c} showMessageListSkeleton={showMessageListSkeleton} showOlderHistorySkeleton={showOlderHistorySkeleton} />
      </div>

      {/* 真审批运行时（Pi、Hermes）在这个对话里等人答复的请求 */}
      {c.isGroup ? (
        // 群协作层（P3）：执行队列、停止的交接链、审批 / 澄清（按 Agent 主人过滤）、摘要与设置入口。
        <RoomCollabLayer groupId={c.activeKey} members={c.currentGroup?.members ?? []} />
      ) : (
        <ChatRunApprovals isGroup={c.isGroup} activeKey={c.activeKey} />
      )}

      <Composer {...c} />

      {/* File Preview Modal */}
      {c.previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal url={c.previewFile.url} filename={c.previewFile.filename} onClose={() => c.setPreviewFile(null)} />
        </Suspense>
      )}

      <DeleteMessageDialog {...c} />
      <FileErrorDialog {...c} />
    </div>
  );
}
