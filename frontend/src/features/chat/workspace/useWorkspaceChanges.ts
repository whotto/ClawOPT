// 单聊里「每次运行的工作区改动」的数据：按当前已加载的助手消息 id 拉摘要。
// 不依赖实时帧（SSE 与 WebSocket 都一样）：历史加载后、以及一轮运行结束（isLoading 从 true 变 false）后各拉一次。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listWorkspaceChanges } from '../../../api/workspaceChanges';
import {
  collectAssistantMessageIds, createRequestSequence, groupChangesByMessage,
  type WorkspaceChange,
} from './workspaceDiff';

export function useWorkspaceChanges(params: {
  enabled: boolean;
  sessionId: string;
  messages: ReadonlyArray<{ id: string; role: string }>;
  isLoading: boolean;
}) {
  const { enabled, sessionId, messages, isLoading } = params;
  const [changes, setChanges] = useState<WorkspaceChange[]>([]);
  const [openTarget, setOpenTarget] = useState<{ change: WorkspaceChange; fileId: number | null } | null>(null);
  const [runEpoch, setRunEpoch] = useState(0);
  const sequenceRef = useRef(createRequestSequence());
  const wasLoadingRef = useRef(isLoading);

  // 一轮结束：最后那条助手消息的改动这时才落库，重新拉。
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading) setRunEpoch((value) => value + 1);
    wasLoadingRef.current = isLoading;
  }, [isLoading]);

  const idsKey = useMemo(() => collectAssistantMessageIds(messages).join(','), [messages]);

  useEffect(() => {
    setChanges([]);
    setOpenTarget(null);
    sequenceRef.current.invalidate();
  }, [sessionId, enabled]);

  useEffect(() => {
    if (!enabled || !sessionId || !idsKey) return;
    const token = sequenceRef.current.next();
    const controller = new AbortController();
    // 流式期间消息 id 会从临时 id 换成库里的 id：稍等一下，合并连续的变化再拉。
    const timer = window.setTimeout(() => {
      listWorkspaceChanges(sessionId, idsKey.split(','), { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) return;
          const payload = await response.json().catch(() => null);
          if (!sequenceRef.current.isCurrent(token)) return;
          setChanges(Array.isArray(payload?.changes) ? payload.changes : []);
        })
        .catch(() => {});
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, sessionId, idsKey, runEpoch]);

  const changesByMessage = useMemo(() => groupChangesByMessage(changes), [changes]);
  const openWorkspaceChange = useCallback((change: WorkspaceChange, fileId: number | null = null) => {
    setOpenTarget({ change, fileId });
  }, []);
  const closeWorkspaceChange = useCallback(() => setOpenTarget(null), []);

  return { workspaceChangesByMessage: changesByMessage, openWorkspaceChangeTarget: openTarget, openWorkspaceChange, closeWorkspaceChange };
}
