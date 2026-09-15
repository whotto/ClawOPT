import { useState } from 'react';
import { deleteSession, getSessionConfigs, listSessions, resetSession } from '../../api/sessions';
import type { ViewType } from '../routeState';

type SessionActionsDeps = {
  reloadSessions: () => Promise<void>;
  activeSessionId: string;
  setActiveSessionId: (id: string) => void;
  currentView: ViewType;
};

/** 智能体详情弹窗，以及删除 / 重置确认弹窗。 */
export function useSessionActions({ reloadSessions, activeSessionId, setActiveSessionId, currentView }: SessionActionsDeps) {
  // Delete Modal State
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);

  // Reset Modal State
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [resettingSessionId, setResettingSessionId] = useState<string | null>(null);

  // Info Modal State
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [viewingSession, setViewingSession] = useState<any>(null);
  const [infoActiveTab, setInfoActiveTab] = useState<string>('soul');

  const confirmDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDeletingSessionId(id);
    setIsDeleteModalOpen(true);
  };

  const handleDeleteSession = async () => {
    if (deletingSessionId) {
      try {
        const res = await deleteSession(deletingSessionId);
        const data = await res.json();
        if (data.success) {
          setIsDeleteModalOpen(false);
          await reloadSessions();
        }
      } catch (err) {
        console.error('Failed to delete session:', err);
      } finally {
        setIsDeleteModalOpen(false);
        setDeletingSessionId(null);
      }
    }
  };

  const confirmResetSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setResettingSessionId(id);
    setIsResetModalOpen(true);
  };

  const handleResetSession = async () => {
    if (resettingSessionId) {
      try {
        const res = await resetSession(resettingSessionId);
        const data = await res.json();
        if (data.success) {
          setIsResetModalOpen(false);
          await reloadSessions();

          // If currently viewing this session, refresh the chat view
          if (activeSessionId === resettingSessionId && currentView === 'chat') {
            // Trigger reload by temporarily switching away and back
            setActiveSessionId('');
            setTimeout(() => setActiveSessionId(resettingSessionId), 50);
          }
        }
      } catch (err) {
        console.error('Failed to reset session:', err);
      } finally {
        setIsResetModalOpen(false);
        setResettingSessionId(null);
      }
    }
  };

  const handleShowInfo = async (e: React.MouseEvent, session: {id: string, name: string}) => {
    e.stopPropagation();
    setIsInfoModalOpen(true);
    setInfoActiveTab('soul');
    setViewingSession(session);

    try {
      const [sessRes, cfgRes] = await Promise.all([
        listSessions(),
        getSessionConfigs(session.id)
      ]);
      const sessData = sessRes.ok ? await sessRes.json() : [];
      const cfgData = cfgRes.ok ? await cfgRes.json() : null;
      const fullSession = sessData.find((s: any) => s.id === session.id) || session;
      const configs = cfgData?.configs || {};
      setViewingSession({ ...fullSession, ...configs });
    } catch (e) {
      console.error('Failed to fetch session details for info', e);
    }
  };

  return {
    isDeleteModalOpen, setIsDeleteModalOpen,
    isResetModalOpen, setIsResetModalOpen,
    isInfoModalOpen, setIsInfoModalOpen,
    viewingSession,
    infoActiveTab, setInfoActiveTab,
    confirmDeleteSession,
    handleDeleteSession,
    confirmResetSession,
    handleResetSession,
    handleShowInfo,
  };
}

export type SessionActionsState = ReturnType<typeof useSessionActions>;
