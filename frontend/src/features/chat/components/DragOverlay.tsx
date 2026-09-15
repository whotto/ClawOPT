// 拖入文件时的全屏提示层。
import { Plus } from 'lucide-react';
import type { ChatController } from '../hooks/useChatController';

type DragOverlayProps = Pick<ChatController, 't' | 'editingMessageId' | 'isDragging'>;

export function DragOverlay(c: DragOverlayProps) {
  const { t, editingMessageId, isDragging } = c;
  return (
    <>
      {isDragging && !editingMessageId && (
        <div className="absolute inset-0 z-[100] bg-blue-600/10 backdrop-blur-sm border-4 border-dashed border-blue-500 flex items-center justify-center p-12 transition-all pointer-events-none">
          <div className="bg-white p-10 rounded-[40px] flex flex-col items-center gap-6 animate-in zoom-in-95 duration-200">
            <div className="w-20 h-20 bg-blue-50 rounded-3xl flex items-center justify-center border border-blue-100"><Plus className="w-10 h-10 text-blue-600" /></div>
            <div className="text-center">
              <p className="text-2xl font-black text-gray-900 tracking-tight">{t('unifiedChat.dragUploadTitle')}</p>
              <p className="text-sm text-gray-500 mt-1 font-medium italic">{t('unifiedChat.dragUploadDescription')}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
