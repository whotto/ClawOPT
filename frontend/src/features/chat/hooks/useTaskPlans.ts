// 任务计划卡数据：按已加载助手消息拉快照 + 会话实时通道的 task.plan.updated，按 revision 合并。
import { useEffect, useMemo, useRef, useState } from 'react';
import { getChatTaskPlans } from '../../../api/chat';
import { mergeTaskPlans, normalizeTaskPlan, plansByMessage, type TaskPlan } from '../lib/taskPlans';
import { collectAssistantMessageIds } from '../workspace/workspaceDiff';

export function useTaskPlans(params: { enabled: boolean; sessionId: string; messages: ReadonlyArray<{ id: string; role: string }>; livePlan: unknown }) {
  const { enabled, sessionId, messages, livePlan } = params;
  const [plans, setPlans] = useState<Record<string, TaskPlan>>({});
  const seqRef = useRef(0);
  useEffect(() => { setPlans({}); seqRef.current += 1; }, [sessionId, enabled]);

  useEffect(() => {
    const plan = normalizeTaskPlan(livePlan);
    if (plan) setPlans((current) => mergeTaskPlans(current, [plan]));
  }, [livePlan]);

  const idsKey = useMemo(() => collectAssistantMessageIds(messages).join(','), [messages]);
  useEffect(() => {
    if (!enabled || !sessionId || !idsKey) return;
    const seq = ++seqRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getChatTaskPlans(sessionId, idsKey.split(','), controller.signal)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!payload || seq !== seqRef.current || !Array.isArray(payload.plans)) return;
          const incoming = payload.plans.map(normalizeTaskPlan).filter(Boolean) as TaskPlan[];
          setPlans((current) => mergeTaskPlans(current, incoming));
        })
        .catch(() => {});
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, sessionId, idsKey]);

  return { taskPlansByMessage: useMemo(() => plansByMessage(plans), [plans]) };
}
