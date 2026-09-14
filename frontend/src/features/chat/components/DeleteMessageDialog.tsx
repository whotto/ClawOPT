// 删除消息确认弹窗。
import { Trash2 } from 'lucide-react';
import type { ChatController } from '../hooks/useChatController';

type DeleteMessageDialogProps = Pick<
  ChatController,
  't' | 'isDeleteModalOpen' | 'setIsDeleteModalOpen' | 'deleteErrorMessage' |
  'setDeleteErrorMessage' | 'confirmDeleteMessage'
>;

export function DeleteMessageDialog(c: DeleteMessageDialogProps) {
  const {
    t, isDeleteModalOpen, setIsDeleteModalOpen, deleteErrorMessage, setDeleteErrorMessage,
    confirmDeleteMessage,
  } = c;
  return (
    <>
      {isDeleteModalOpen && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity animate-in fade-in duration-200" onClick={() => { setDeleteErrorMessage(''); setIsDeleteModalOpen(false); }}></div>
          <div className="bg-white rounded-[32px] border border-gray-200 w-full max-w-[340px] max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
            <div className="p-8 text-center">
              <div className="mx-auto flex items-center justify-center h-16 w-16 rounded-3xl bg-red-50 mb-6 border border-red-100"><Trash2 className="h-8 w-8 text-red-500" /></div>
              <h3 className="text-xl font-black text-gray-900 mb-2 tracking-tight">{t('unifiedChat.deleteMessageTitle')}</h3>
              <p className="text-sm text-gray-500 leading-relaxed px-2">{t('unifiedChat.deleteMessageDescription')}</p>
              {deleteErrorMessage ? (
                <p className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-left text-sm whitespace-pre-line text-red-600">
                  {deleteErrorMessage}
                </p>
              ) : null}
            </div>
            <div className="p-5 bg-gray-50/80 flex gap-3 border-t border-gray-100">
              <button type="button" onClick={() => { setDeleteErrorMessage(''); setIsDeleteModalOpen(false); }} className="flex-1 px-4 py-3 text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.cancel')}</button>
              <button type="button" onClick={confirmDeleteMessage} className="flex-1 px-4 py-3 text-white bg-red-600 hover:bg-red-700 active:scale-95 rounded-2xl font-bold text-sm transition-all">{t('common.confirmDelete')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
