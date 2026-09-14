import { useTranslation } from 'react-i18next';
import { Reorder } from 'motion/react';
import type { SidebarProps } from './Sidebar';
import { GroupCard } from './SidebarCards';
import type { GroupSummary } from './sidebarTypes';
import type { GroupDetailsState } from './useGroupDetails';

export default function GroupList({
  sidebar,
  enableReorder,
  groups,
  reorderGroups,
  groupDetails,
}: {
  sidebar: SidebarProps;
  enableReorder: boolean;
  groups: GroupSummary[];
  reorderGroups: (newGroups: GroupSummary[]) => Promise<void>;
  groupDetails: GroupDetailsState;
}) {
  const { t } = useTranslation();
  const renderGroupCard = (g: GroupSummary) => <GroupCard g={g} sidebar={sidebar} groupDetails={groupDetails} />;
  return (
    groups.length > 0 ? (
      enableReorder ? (
        <Reorder.Group axis="y" values={groups} onReorder={reorderGroups} className="space-y-1" layout={false}>
          {groups.map((g) => (
            <Reorder.Item key={g.id} value={g} className="w-full" initial={false}>
              {renderGroupCard(g)}
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <div className="space-y-1">
          {groups.map((g) => (
            <div key={g.id}>{renderGroupCard(g)}</div>
          ))}
        </div>
      )
    ) : (
      <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
        <p className="text-sm text-gray-400 font-medium">{t('sidebar.noItems')}</p>
      </div>
    )
  );
}
