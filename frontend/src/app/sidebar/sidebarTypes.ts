import type { ModelFallbackMode } from '../../components/ModelFallbackEditor';

export type AppVersionInfo = {
  version: string;
  openclawVersion: string | null;
};

export type GroupSummary = {
  id: string;
  name: string;
  members?: { agent_id: string; display_name: string }[];
  [key: string]: any;
};

export type SidebarSession = { id: string; name: string; agentId?: string };

export type SidebarListTab = 'agents' | 'groups' | 'favorites';
export type SidebarFavoriteType = 'agents' | 'groups';
export type AgentRuntimeMode = 'configured' | 'direct';
export type AgentSystemPromptMode = 'system' | 'agent';
export type AgentToolMode = 'full' | 'coding' | 'messaging' | 'minimal' | 'off';
export type AgentRuntimeMetrics = {
  systemPrompt?: {
    systemChars?: number | null;
    agentChars?: number | null;
  };
  tools?: {
    charsByMode?: Partial<Record<AgentToolMode, number | null>>;
  };
};
export type AgentEditorTab = 'soul' | 'user' | 'agents' | 'tools' | 'heartbeat' | 'identity';
type AgentEditorContentKey = 'soulContent' | 'userContent' | 'agentsContent' | 'toolsContent' | 'heartbeatContent' | 'identityContent';
export type SidebarFavorites = {
  agents: string[];
  groups: string[];
  order: string[];
};

/** 新建 / 编辑智能体弹窗的表单数据。 */
export type AgentFormData = {
  id: string;
  name: string;
  model: string;
  process_start_tag: string;
  process_end_tag: string;
  runtimeMode: AgentRuntimeMode;
  systemPromptMode: AgentSystemPromptMode;
  toolMode: AgentToolMode;
  runtimeMetrics: AgentRuntimeMetrics | null;
  soulContent: string;
  userContent: string;
  agentsContent: string;
  toolsContent: string;
  heartbeatContent: string;
  identityContent: string;
  fallbackMode: ModelFallbackMode;
  fallbacks: string[];
};

export type GroupMemberDraft = {
  agentId: string;
  displayName: string;
  roleDescription: string;
  /** P2：成员运行时（缺省 openclaw）与外部配置（不含密钥）。 */
  runtime?: string;
  externalConfig?: Record<string, unknown>;
  /** 远程 OpenClaw 成员的令牌：只在草稿里，保存群之后经只写接口进加密存储，从不回显。 */
  remoteToken?: string;
  hasRemoteToken?: boolean;
};

/** 成员运行时选择器的一项（后端 GET /api/runtime/member-runtimes）。 */
export type MemberRuntimeOption = import('../../components/runtime/runtimeSelection').RuntimeOption;

/** 从群成员行（后端形状）还原编辑草稿里的运行时字段。 */
export function memberRuntimeDraftFields(member: { runtime?: string | null; external_config?: string | null }): Pick<GroupMemberDraft, 'runtime' | 'externalConfig'> {
  let externalConfig: Record<string, unknown> | undefined;
  if (member.external_config) {
    try {
      const parsed = JSON.parse(member.external_config);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) externalConfig = parsed;
    } catch {
      externalConfig = undefined;
    }
  }
  return { runtime: member.runtime || 'openclaw', externalConfig };
}

export const MODAL_FORM_FONT_STYLE = {
  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
} as const;
export const MODAL_FIELD_LABEL_CLASS = 'block text-sm font-semibold text-gray-700 mb-1.5';
export const MODAL_TEXT_INPUT_CLASS = 'w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
export const MODAL_TEXTAREA_CLASS = 'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-[15px] text-gray-900 placeholder:text-gray-400 outline-none transition-all resize-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500';
export const MODAL_EDITOR_TEXTAREA_CLASS = 'w-full h-36 p-4 bg-transparent outline-none transition-all resize-none text-[15px] text-gray-900 border-0 focus:ring-0 leading-relaxed placeholder:text-gray-400';
export const AGENT_EDITOR_CONTENT_KEYS: Record<AgentEditorTab, AgentEditorContentKey> = {
  soul: 'soulContent',
  user: 'userContent',
  agents: 'agentsContent',
  tools: 'toolsContent',
  heartbeat: 'heartbeatContent',
  identity: 'identityContent',
};
export const SIDEBAR_CARD_ACTION_BUTTON_CLASS = 'p-1.5 rounded-lg bg-blue-50 text-blue-500 hover:bg-yellow-100 hover:text-yellow-600 transition-all md:opacity-0 md:group-hover:opacity-100';
