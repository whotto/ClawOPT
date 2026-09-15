// 群聊页的协作层（P3）：挂在消息列表与输入框之间——执行队列、停止的交接链、待决审批 / 澄清，
// 以及一条工具条（摘要状态、协作设置、工作区、远程 Agent）。所有状态在 useRoomCollab，这里只摆放与发请求。
import { FolderOpen, PlugZap, Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAccess } from '../../app/access';
import { RoomApiError, roomApi, type HandoffChain, type RoomInteraction } from './api';
import { RoomInteractions } from './RoomInteractions';
import { RoomQueueStrip, StoppedChainCards } from './RoomQueueStrip';
import { RoomSettingsDialog } from './RoomSettingsDialog';
import { roomQueueCapability } from './roomStorage';
import { RoomSummaryPanel, SummaryChip } from './RoomSummaryPanel';
import { RoomWorkspaceDrawer } from './RoomWorkspace';
import { useRoomCollab } from './useRoomCollab';

type Panel = null | 'summary' | 'settings' | 'relay' | 'workspace';

export function RoomCollabLayer({ groupId, members }: {
  groupId: string;
  members: Array<{ id: string; agent_id: string; display_name: string }>;
}) {
  const { t } = useTranslation();
  const { user } = useAccess();
  const collab = useRoomCollab(groupId);
  const [panel, setPanel] = useState<Panel>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, member.display_name || member.agent_id])), [members]);
  const canManage = !!collab.policy?.canManage;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusyAction(key);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof RoomApiError ? String(t(err.code, { defaultValue: err.message })) : String((err as Error)?.message ?? err));
    } finally {
      setBusyAction(null);
    }
  };

  const onRetract = (messageId: number) => run(`retract:${messageId}`, async () => {
    await roomApi.retract(groupId, messageId, roomQueueCapability(groupId));
    collab.reloadQueue();
  });
  const onContinue = (chain: HandoffChain) => run(`continue:${chain.chainId}`, async () => {
    await roomApi.continueChain(groupId, chain.chainId);
    collab.reloadChains();
  });
  const onRespond = (interaction: RoomInteraction, response: { choice?: string; text?: string }) => run(interaction.id, async () => {
    await roomApi.respond(groupId, interaction.id, response);
    collab.setInteractions(collab.interactions.filter((item) => item.id !== interaction.id));
  });
  const canRetract = (_messageId: number, requesterKind: string, requesterUserId: number | null) => (
    requesterKind === 'user' && (!!user?.implicit || (user?.id ?? null) === requesterUserId)
  );

  return (
    <>
      <RoomQueueStrip queue={collab.queue} memberNames={memberNames} canRetract={canRetract} onRetract={onRetract} busyAction={busyAction} />
      <StoppedChainCards chains={collab.chains} canContinue={collab.canManageChains} onContinue={onContinue} busyAction={busyAction} />
      <RoomInteractions interactions={collab.interactions} onRespond={onRespond} busyId={busyAction} />
      <div className="px-4 pt-2 max-w-5xl w-full mx-auto flex items-center gap-1.5" data-testid="room-collab-toolbar">
        <SummaryChip summary={collab.summary} onOpen={() => setPanel('summary')} />
        {canManage && (
          <button type="button" onClick={() => setPanel('settings')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 h-8 text-xs text-gray-600 hover:bg-gray-50" data-testid="room-open-settings">
            <Settings2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t('rooms.toolbar.settings')}</span>
          </button>
        )}
        {canManage && (
          <button type="button" onClick={() => setPanel('workspace')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 h-8 text-xs text-gray-600 hover:bg-gray-50" data-testid="room-open-workspace">
            <FolderOpen className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t('rooms.toolbar.workspace')}</span>
          </button>
        )}
        <button type="button" onClick={() => setPanel('relay')} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2 h-8 text-xs text-gray-600 hover:bg-gray-50" data-testid="room-open-relay">
          <PlugZap className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t('rooms.toolbar.relay')}</span>
        </button>
        {error && <span className="ml-2 text-xs text-red-600 truncate" role="alert">{error}</span>}
      </div>
      {panel === 'summary' && (
        <RoomSummaryPanel groupId={groupId} summary={collab.summary} canManage={canManage} onClose={() => setPanel(null)} onChanged={() => collab.reloadSummary()} />
      )}
      {(panel === 'settings' || panel === 'relay') && (
        <RoomSettingsDialog groupId={groupId} policy={collab.policy} initialTab={panel === 'relay' ? 'relay' : 'policy'} onClose={() => setPanel(null)} onChanged={() => { collab.reloadPolicy(); collab.reloadSummary(); collab.reloadChains(); }} />
      )}
      {panel === 'workspace' && <RoomWorkspaceDrawer groupId={groupId} refreshTick={collab.workspaceDiffTick} onClose={() => setPanel(null)} />}
    </>
  );
}
