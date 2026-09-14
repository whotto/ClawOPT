import { useTranslation } from 'react-i18next';
import { RefreshCw, Trash2 } from 'lucide-react';
import { deleteGroup, resetGroup } from '../../api/groups';
import type { SidebarProps } from './Sidebar';
import type { GroupDetailsState } from './useGroupDetails';

type GroupConfirmProps = {
  sidebar: SidebarProps;
  groupDetails: GroupDetailsState;
  reloadGroups: () => Promise<void>;
};

export function DeleteGroupModal({ sidebar, groupDetails, reloadGroups }: GroupConfirmProps) {
  const { t } = useTranslation();
  const { activeGroupId, onSelectGroup, navigateTo, settingsTab = 'gateway' } = sidebar;
  const { viewingGroup, setViewingGroup, setIsDeleteGroupModalOpen } = groupDetails;
  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsDeleteGroupModalOpen(false)} />
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
            <Trash2 className="h-6 w-6 text-red-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">{t('common.confirmDelete')}</h3>
          <p className="text-sm text-gray-500">{t('sidebar.confirmDeleteGroup')} {t('sidebar.warningUndone')}</p>
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button
            onClick={() => setIsDeleteGroupModalOpen(false)}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={async () => {
              try {
                await deleteGroup(viewingGroup.id);
                setIsDeleteGroupModalOpen(false);
                setViewingGroup(null);
                if (activeGroupId === viewingGroup.id) {
                  onSelectGroup('');
                  navigateTo('chat', settingsTab, false);
                }
                await reloadGroups();
              } catch {}
            }}
            className="flex-1 px-4 py-2.5 text-white bg-red-600 hover:bg-red-700 rounded-xl font-semibold transition-all"
          >
            {t('common.confirmDelete')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResetGroupModal({ sidebar, groupDetails, reloadGroups }: GroupConfirmProps) {
  const { t } = useTranslation();
  const { activeGroupId, onSelectGroup, currentView } = sidebar;
  const { viewingGroup, setIsResetGroupModalOpen } = groupDetails;
  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsResetGroupModalOpen(false)} />
      <div className="bg-white rounded-2xl border border-gray-200 w-full max-w-sm max-h-[calc(100vh-2rem)] overflow-y-auto relative z-10 animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6 text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-orange-100 mb-4">
            <RefreshCw className="h-6 w-6 text-orange-600" />
          </div>
          <h3 className="text-lg font-bold text-gray-900 mb-2">{t('sidebar.confirmResetGroup')}</h3>
          <p className="text-sm text-gray-500">{t('sidebar.resetGroupWarning')}</p>
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button
            onClick={() => setIsResetGroupModalOpen(false)}
            className="flex-1 px-4 py-2.5 text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 rounded-xl font-semibold transition-all"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={async () => {
              try {
                await resetGroup(viewingGroup.id);
                setIsResetGroupModalOpen(false);
                await reloadGroups();

                // If currently viewing this group, refresh the group chat view
                if (activeGroupId === viewingGroup.id && currentView === 'groups') {
                  // Trigger reload by temporarily switching away and back
                  onSelectGroup('');
                  setTimeout(() => onSelectGroup(viewingGroup.id), 50);
                }
              } catch (err) {
                console.error('Failed to reset group:', err);
              }
            }}
            className="flex-1 px-4 py-2.5 text-white bg-orange-600 hover:bg-orange-700 rounded-xl font-semibold transition-all"
          >
            {t('common.reset')}
          </button>
        </div>
      </div>
    </div>
  );
}
