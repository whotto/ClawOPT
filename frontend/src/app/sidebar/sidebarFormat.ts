import type { AgentFormData, SidebarSession } from './sidebarTypes';

export function resolveSidebarSubmitError(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; errorDetail?: string | null; error?: string; message?: string },
  t: (key: string, options?: any) => string,
  fallbackKey: string
): string {
  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      return translated;
    }
  }

  if (typeof data.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  if (typeof data.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }

  if (typeof data.errorDetail === 'string' && data.errorDetail.trim()) {
    return data.errorDetail.trim();
  }

  return t(fallbackKey);
}

/** 群成员显示名：优先取对应会话的名字，其次成员自带的显示名，最后是 agentId。 */
export function resolveGroupMemberDisplayName(
  member: { agent_id?: string; agentId?: string; display_name?: string; displayName?: string },
  sessions: SidebarSession[],
): string {
  const agentId = member.agent_id || member.agentId || '';
  const linkedSession = sessions.find((session) => (session.agentId || session.id) === agentId);
  return linkedSession?.name || member.display_name || member.displayName || agentId;
}

export function formatCompactCount(count: number, language: string): string {
  if (language.startsWith('zh')) {
    if (count >= 10000) {
      return `${(count / 10000).toFixed(1).replace(/\.0$/, '')}万`;
    }
    return count.toLocaleString();
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return count.toLocaleString();
}

/** 「智能体自带提示词」模式下本地估算的系统提示词字符数，拼法与运行时一致。 */
export function buildLocalAgentPromptChars(data: AgentFormData): number {
  const sections = [
    ['IDENTITY.md', data.identityContent],
    ['SOUL.md', data.soulContent],
    ['AGENTS.md', data.agentsContent],
    ['USER.md', data.userContent],
    ['TOOLS.md', data.toolsContent],
    ['HEARTBEAT.md', data.heartbeatContent],
  ]
    .map(([filename, content]) => [filename, String(content || '').trim()] as const)
    .filter(([, content]) => content.length > 0)
    .map(([filename, content]) => `## ${filename}\n\n${content}`);

  if (sections.length === 0) {
    return 0;
  }

  return [
    `# Agent ${data.id || 'agent'}`,
    'Follow this agent-specific prompt. The sections below come from this agent workspace.',
    ...sections,
  ].join('\n\n').length;
}
