import { useTranslation } from 'react-i18next';
import { Reorder } from 'motion/react';
import type { SidebarProps } from './Sidebar';
import { GroupCard, SessionCard } from './SidebarCards';
import { parseSidebarFavoriteKey } from './sidebarFavorites';
import type { GroupSummary, SidebarFavorites } from './sidebarTypes';
import type { GroupDetailsState } from './useGroupDetails';

export default function FavoritesList({
  sidebar,
  enableReorder,
  groups,
  sidebarFavorites,
  reorderFavorites,
  groupDetails,
  onShowInfo,
}: {
  sidebar: SidebarProps;
  enableReorder: boolean;
  groups: GroupSummary[];
  sidebarFavorites: SidebarFavorites;
  reorderFavorites: (nextOrder: string[]) => void;
  groupDetails: GroupDetailsState;
  onShowInfo: (e: React.MouseEvent, session: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const { sessions } = sidebar;
  const renderSessionCard = (s: { id: string; name: string }) => <SessionCard s={s} sidebar={sidebar} onShowInfo={onShowInfo} />;
  const renderGroupCard = (g: GroupSummary) => <GroupCard g={g} sidebar={sidebar} groupDetails={groupDetails} />;
  return (
    sidebarFavorites.order.length > 0 ? (
      enableReorder ? (
        <Reorder.Group axis="y" values={sidebarFavorites.order} onReorder={reorderFavorites} className="space-y-1" layout={false}>
          {sidebarFavorites.order.map((favoriteKey) => {
            const parsed = parseSidebarFavoriteKey(favoriteKey);
            if (!parsed) return null;

            if (parsed.type === 'agents') {
              const session = sessions.find((item) => item.id === parsed.id);
              if (!session) return null;
              return (
                <Reorder.Item key={favoriteKey} value={favoriteKey} className="w-full" initial={false}>
                  {renderSessionCard(session)}
                </Reorder.Item>
              );
            }

            const group = groups.find((item) => item.id === parsed.id);
            if (!group) return null;
            return (
              <Reorder.Item key={favoriteKey} value={favoriteKey} className="w-full" initial={false}>
                {renderGroupCard(group)}
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      ) : (
        <div className="space-y-1">
          {sidebarFavorites.order.map((favoriteKey) => {
            const parsed = parseSidebarFavoriteKey(favoriteKey);
            if (!parsed) return null;

            if (parsed.type === 'agents') {
              const session = sessions.find((item) => item.id === parsed.id);
              return session ? <div key={favoriteKey}>{renderSessionCard(session)}</div> : null;
            }

            const group = groups.find((item) => item.id === parsed.id);
            return group ? <div key={favoriteKey}>{renderGroupCard(group)}</div> : null;
          })}
        </div>
      )
    ) : (
      <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
        <p className="text-sm text-gray-400 font-medium">{t('sidebar.noFavorites')}</p>
      </div>
    )
  );
}
