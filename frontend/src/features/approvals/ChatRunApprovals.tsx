// 聊天页里的审批卡（输入区上方）：当前单聊 / 群里等人答复的运行审批。
import RunApprovalCard from './RunApprovalCard';
import { approvalsForContext } from './runApprovals';
import { useRunApprovals } from './useRunApprovals';

export default function ChatRunApprovals({ isGroup, activeKey }: { isGroup: boolean; activeKey: string }) {
  const { approvals, busyId, respond } = useRunApprovals();
  const visible = activeKey ? approvalsForContext(approvals, { kind: isGroup ? 'group' : 'chat', id: activeKey }) : [];
  if (!visible.length) return null;
  return (
    <div className="px-4 pt-2 space-y-2 max-w-4xl w-full mx-auto" data-testid="chat-run-approvals">
      {visible.map((approval) => (
        <RunApprovalCard key={approval.id} approval={approval} busy={busyId === approval.id} onRespond={(choice) => void respond(approval, choice)} />
      ))}
    </div>
  );
}
