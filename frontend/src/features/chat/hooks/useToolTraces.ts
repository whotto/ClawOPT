// 助手消息的工具摘要卡数据：按已加载的助手消息 id 拉；一轮结束（isLoading true → false）再拉一次。请求序号守卫。
import { useEffect, useMemo, useRef, useState } from 'react';
import { getChatToolCalls } from '../../../api/chat';
import { groupTracesByMessage, type ToolTraceRun } from '../lib/toolTrace';
import { collectAssistantMessageIds } from '../workspace/workspaceDiff';

export function useToolTraces(params: { enabled: boolean; sessionId: string; messages: ReadonlyArray<{ id: string; role: string }>; isLoading: boolean }) {
  const { enabled, sessionId, messages, isLoading } = params;
  const [runs, setRuns] = useState<ToolTraceRun[]>([]);
  const [runEpoch, setRunEpoch] = useState(0);
  const wasLoadingRef = useRef(isLoading);
  const seqRef = useRef(0);

  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) setRunEpoch((value) => value + 1);
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  useEffect(() => { setRuns([]); seqRef.current += 1; }, [sessionId, enabled]);

  const idsKey = useMemo(() => collectAssistantMessageIds(messages).join(','), [messages]);

  useEffect(() => {
    if (!enabled || !sessionId || !idsKey) return;
    const seq = ++seqRef.current;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getChatToolCalls(sessionId, idsKey.split(','), controller.signal)
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => { if (payload && seq === seqRef.current) setRuns(Array.isArray(payload.runs) ? payload.runs : []); })
        .catch(() => {});
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [enabled, sessionId, idsKey, runEpoch]);

  return { toolTracesByMessage: useMemo(() => groupTracesByMessage(runs), [runs]) };
}
