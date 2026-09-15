// 聊天页内部类型与页面 props。

export type NavDotSummary = {
  primary: string;
  secondary?: string;
  tooltipText: string;
};
export type NavDot = { id: string; top: number; offsetTop: number; summary: NavDotSummary };
export type HistoryPagingDirection = 'older' | 'newer';
export type HistoryPageNotice = {
  id: number;
  direction: HistoryPagingDirection;
};
export type SearchMatch = {
  messageId: string;
  anchorBeforeId: number | null;
};
export type GroupRunState = {
  active: boolean;
  agentId: string | null;
  runId: string | null;
  startedAt: number | null;
};

export interface GroupChat {
  id: string;
  name: string;
  description?: string;
  process_start_tag?: string;
  process_end_tag?: string;
  members: { id: string; group_id: string; agent_id: string; display_name: string; role_description: string; position: number }[];
}

export interface GroupMember {
  agentId: string;
  displayName: string;
  roleDescription: string;
}

export type GroupChatMember = GroupChat['members'][number];

export interface ChatViewProps {
  mode: 'chat' | 'group';
  onMenuClick: () => void;
  sessions: { id: string; name: string; agentId?: string; characterId?: string; model?: string; runtimeMode?: string; runtime_mode?: string; process_start_tag?: string; process_end_tag?: string }[];
  // Chat mode
  isConnected?: boolean;
  activeSessionId?: string;
  // Group mode
  activeGroupId?: string | null;
  onSelectGroup?: (id: string) => void;
  availableModels?: any[];
}
