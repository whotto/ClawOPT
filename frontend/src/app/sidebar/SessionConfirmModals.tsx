import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { SessionActionsState } from './useSessionActions';

export function DeleteSessionModal({ actions }: { actions: SessionActionsState }) {
  const { t } = useTranslation();
  const { setIsDeleteModalOpen, handleDeleteSession } = actions;
  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsDeleteModalOpen(false)}></div>
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
            <Trash2 className="h-6 w-6 text-red-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">{t('sidebar.confirmDeleteAgent')}</h3>
          <p className="text-sm text-gray-500">
            {t('sidebar.warningUndone')}
          </p>
        </div>
        <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setIsDeleteModalOpen(false)}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleDeleteSession}
            className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
          >
            {t('common.confirmDelete')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResetSessionModal({ actions }: { actions: SessionActionsState }) {
  const { t } = useTranslation();
  const { setIsResetModalOpen, handleResetSession } = actions;
  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" onClick={() => setIsResetModalOpen(false)}></div>
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-orange-100 mb-4">
            <RefreshCw className="h-6 w-6 text-orange-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">{t('sidebar.confirmResetAgent')}</h3>
          <p className="text-sm text-gray-500">
            {t('sidebar.resetAgentWarning')}
          </p>
        </div>
        <div className="p-4 bg-gray-50 flex gap-3 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setIsResetModalOpen(false)}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleResetSession}
            className="flex-1 px-4 py-2.5 text-white bg-orange-600 hover:bg-orange-700 rounded-xl font-semibold transition-all"
          >
            {t('common.reset')}
          </button>
        </div>
      </div>
    </div>
  );
}
