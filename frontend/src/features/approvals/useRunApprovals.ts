// 运行审批列表：订阅 `/ws` 的 `approvals:runs`（不带内容）后经 HTTP 重新拉，订阅不到退回轮询；答复后本地先摘掉。
import { useCallback, useEffect, useState } from 'react';
import { listRunApprovals, respondRunApproval } from '../../api/runtime';
import { watchPendingApprovals } from '../workflow/lib/workflowStream';
import type { RunApproval, RunApprovalChoice } from './runApprovals';

export function useRunApprovals() {
  const [approvals, setApprovals] = useState<RunApproval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let seq = 0;
    const reload = async () => {
      const current = ++seq;
      try {
        const response = await listRunApprovals();
        const body = response.ok ? await response.json() : null;
        if (!stopped && current === seq && Array.isArray(body?.approvals)) setApprovals(body.approvals);
      } catch {
        // 下一次提醒或轮询再拉
      }
    };
    const stop = watchPendingApprovals(() => { void reload(); }, { topic: 'approvals:runs' });
    return () => {
      stopped = true;
      stop();
    };
  }, []);

  const respond = useCallback(async (approval: RunApproval, choice: RunApprovalChoice) => {
    setBusyId(approval.id);
    try {
      const response = await respondRunApproval(approval.id, choice);
      // 已经被别处答掉（409）也从本地摘掉：提醒会带来最新列表。
      if (response.ok || response.status === 409 || response.status === 404) {
        setApprovals((current) => current.filter((item) => item.id !== approval.id));
      }
    } finally {
      setBusyId(null);
    }
  }, []);

  return { approvals, busyId, respond };
}
