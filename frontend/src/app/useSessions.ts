import { useCallback, useEffect, useState } from 'react';
import { listSessionsWithTimeout, reorderSessions as saveSessionOrder } from '../api/sessions';
import { BOOTSTRAP_REQUEST_TIMEOUT_MS } from './bootstrap';

export type SessionSummary = {
  id: string;
  name: string;
  agentId?: string;
  characterId?: string;
  model?: string;
  process_start_tag?: string;
  process_end_tag?: string;
  /** 外部运行时单聊（后端 `GET /api/sessions` 回 `externalRuntime`）；普通 OpenClaw 会话没有。 */
  externalRuntime?: string;
};

/**
 * 单聊会话列表。加载后若当前选中的会话已不在列表里，自动选第一个。
 * `autoSelectSession` 由导航层提供，保证这类纠偏不进浏览历史。
 */
export function useSessions(autoSelectSession: (pick: (prev: string) => string) => void) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  const reloadSessions = useCallback(async () => {
    try {
      const data = await listSessionsWithTimeout<SessionSummary[]>(BOOTSTRAP_REQUEST_TIMEOUT_MS);
      setSessions(data);
      // Auto-select first session if currently active is not in the list or empty
      if (data.length > 0) {
        autoSelectSession(prev => {
          const exists = data.find((s: any) => s.id === prev);
          return exists ? prev : data[0].id;
        });
      }
    } catch (err) {
      console.error('Failed to reload sessions:', err);
    } finally {
      setSessionsLoaded(true);
    }
  }, [autoSelectSession]);

  const reorderSessions = async (newSessions: { id: string; name: string }[]) => {
    // Optimistic update
    setSessions(newSessions);
    try {
      await saveSessionOrder(newSessions.map(s => s.id));
    } catch (err) {
      console.error('Failed to save session order:', err);
      // Fallback on failure
      reloadSessions();
    }
  };

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions]);

  return { sessions, sessionsLoaded, reloadSessions, reorderSessions };
}
