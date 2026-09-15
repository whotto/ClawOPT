import { useTranslation } from 'react-i18next';
import { Reorder } from 'motion/react';
import type { SidebarProps } from './Sidebar';
import { SessionCard } from './SidebarCards';

function SessionSkeleton() {
  return (
    <div className="space-y-1">
      {[1, 2, 3].map(i => (
        <div key={i} className="w-full py-2 px-3 rounded-xl border border-transparent animate-pulse">
          <div className="flex items-baseline gap-2">
            <div className="h-4 bg-gray-200 rounded-md w-20" />
            <div className="h-3 bg-gray-100 rounded-md w-12" />
          </div>
          <div className="mt-2">
            <div className="h-5 bg-gray-100 rounded-full w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 智能体列表。首帧用静态列表，挂载后换成可拖拽排序的 Reorder（enableReorder）。 */
export default function AgentList({
  sidebar,
  enableReorder,
  onShowInfo,
}: {
  sidebar: SidebarProps;
  enableReorder: boolean;
  onShowInfo: (e: React.MouseEvent, session: { id: string; name: string }) => void;
}) {
  const { t } = useTranslation();
  const { sessionsLoaded, sessions, reorderSessions } = sidebar;
  const renderSessionCard = (s: { id: string; name: string }) => <SessionCard s={s} sidebar={sidebar} onShowInfo={onShowInfo} />;
  return (
    !sessionsLoaded ? (
      <SessionSkeleton />
    ) : enableReorder ? (
      <Reorder.Group axis="y" values={sessions} onReorder={reorderSessions} className="space-y-1" layout={false}>
        {sessions.length > 0 ? (
          sessions.map((s) => (
            <Reorder.Item key={s.id} value={s} className="w-full" initial={false}>
              {renderSessionCard(s)}
            </Reorder.Item>
          ))
        ) : (
          <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
            <p className="text-sm text-gray-400 font-medium">{t('sidebar.noItems')}</p>
          </div>
        )}
      </Reorder.Group>
    ) : (
      <ul className="space-y-1">
        {sessions.length > 0 ? (
          sessions.map((s) => (
            <li key={s.id} className="w-full">{renderSessionCard(s)}</li>
          ))
        ) : (
          <div className="w-full h-[58px] flex items-center justify-center bg-white/50 rounded-xl border border-dashed border-gray-200">
            <p className="text-sm text-gray-400 font-medium">{t('sidebar.noItems')}</p>
          </div>
        )}
      </ul>
    )
  );
}
