import { useTranslation } from 'react-i18next';
import { GripVertical, Info, Star } from 'lucide-react';
import type { SidebarProps } from './Sidebar';
import { resolveGroupMemberDisplayName } from './sidebarFormat';
import { SIDEBAR_CARD_ACTION_BUTTON_CLASS as sidebarCardActionButtonClass, type GroupSummary, type SidebarFavoriteType } from './sidebarTypes';
import type { GroupDetailsState } from './useGroupDetails';
import type { useSidebarFavorites } from './useSidebarFavorites';

type Favorites = ReturnType<typeof useSidebarFavorites>;

export function FavoriteButton({
  type,
  id,
  className = sidebarCardActionButtonClass,
  favorites,
}: {
  type: SidebarFavoriteType;
  id: string;
  className?: string;
  favorites: Pick<Favorites, 'isFavorite' | 'toggleFavorite'>;
}) {
  const { t } = useTranslation();
  const { isFavorite, toggleFavorite } = favorites;
  const favoriteActive = isFavorite(type, id);

  return (
    <button
      type="button"
      onClick={(event) => toggleFavorite(type, id, event)}
      className={className}
      title={favoriteActive ? t('sidebar.removeFromFavorites') : t('sidebar.addToFavorites')}
      aria-label={favoriteActive ? t('sidebar.removeFromFavorites') : t('sidebar.addToFavorites')}
    >
      <Star className={`w-4 h-4 ${favoriteActive ? 'fill-current' : ''}`} />
    </button>
  );
}

export function SessionCard({
  s,
  sidebar,
  onShowInfo: handleShowInfo,
}: {
  s: { id: string; name: string };
  sidebar: SidebarProps;
  onShowInfo: (e: React.MouseEvent, session: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const { setActiveSessionId, onSelectGroup, navigateTo, settingsTab = 'gateway', activeSessionId, currentView, availableModels } = sidebar;
  return (
    <div
      onClick={() => { setActiveSessionId(s.id); onSelectGroup(''); navigateTo('chat', settingsTab, false); }}
      className={`w-full group text-left py-2 pr-3 pl-2 text-sm rounded-xl transition-all flex items-center justify-between cursor-pointer border ${activeSessionId === s.id && currentView === 'chat' ? 'font-semibold bg-amber-50 border-orange-300 text-gray-600' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
    >
      <div className="flex flex-1 min-w-0 items-start gap-2">
        <GripVertical className="h-3.5 w-3.5 self-center shrink-0 cursor-grab text-gray-300 transition-colors group-hover:text-gray-400 active:cursor-grabbing" />
        <div className="flex flex-col items-start gap-1.5 w-full">
          <div className="text-[15px] truncate w-full flex-1 min-w-0 text-gray-900">
            {s.name || t('sidebar.agentNum').replace('{{num}}', s.id)}
          </div>
          {(() => {
            // 副标题回答的是「这个 Agent 由谁来跑」，而答案就写在它的模型 ref 里。
            //
            // 外接 Agent（Claude Code 等）是一个模型 ref —— `claude-cli/claude-sonnet-5`，
            // 别名 `Claude Code`。所以这里显示模型别名，对普通 Agent 和外接 Agent
            // 都是对的，不需要第二套显示逻辑。
            const mId = (s as any).model;
            if (!mId) return null;
            const mInfo = availableModels.find(m => m.id === mId);
            return (
              <div className="text-[11px] font-medium truncate max-w-full text-gray-500">
                {mInfo?.alias || mId}
              </div>
            );
          })()}
        </div>
      </div>
      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
        <button 
          onClick={(e) => handleShowInfo(e, s)} 
          className={sidebarCardActionButtonClass}
          title={t('common.details')}
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export function GroupCard({
  g,
  sidebar,
  groupDetails,
}: {
  g: GroupSummary;
  sidebar: SidebarProps;
  groupDetails: GroupDetailsState;
}) {
  const { t } = useTranslation();
  const { setActiveSessionId, onSelectGroup, navigateTo, settingsTab = 'gateway', activeGroupId, currentView, sessions } = sidebar;
  const { setViewingGroup, setInfoActiveRoleTab, setIsGroupInfoOpen } = groupDetails;
  const resolveGroupMemberDisplayNameForSessions = (member: Parameters<typeof resolveGroupMemberDisplayName>[0]) => resolveGroupMemberDisplayName(member, sessions);
  const isActive = activeGroupId === g.id && currentView === 'groups';

  return (
    <div
      onClick={() => { setActiveSessionId(''); onSelectGroup(g.id); navigateTo('groups', settingsTab, false); }}
      className={`w-full group text-left py-2 pr-3 pl-2 text-sm rounded-xl transition-all flex items-center justify-between cursor-pointer border ${isActive ? 'font-semibold bg-amber-50 border-orange-300 text-gray-600' : 'font-normal text-gray-600 hover:bg-gray-200 hover:font-semibold border-transparent'}`}
    >
      <div className="flex flex-1 min-w-0 items-start gap-2">
        <GripVertical className="h-3.5 w-3.5 self-center shrink-0 cursor-grab text-gray-300 transition-colors group-hover:text-gray-400 active:cursor-grabbing" />
        <div className="flex flex-col items-start gap-1.5 w-full">
          <div className="text-[15px] truncate w-full flex-1 min-w-0 text-gray-900">
            {g.name}
          </div>
          <div className="text-[11px] font-medium truncate max-w-full text-gray-500">
            {g.members?.map((m: any) => resolveGroupMemberDisplayNameForSessions(m)).join('、')}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 ml-2 flex-shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); setViewingGroup(g); if(g.members && g.members.length > 0) setInfoActiveRoleTab(g.members[0].agent_id); setIsGroupInfoOpen(true); }}
          className={sidebarCardActionButtonClass}
          title={t('common.details')}
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
