// 角色预设库与 .clawpack 导入导出用到的接口数据形状。

type PresetRole = {
  id: string;
  name: string;
  emoji: string;
  position: string;
  slogan: string;
  skills: string[];
  externalSkills: string[];
  recommended: boolean;
  note: string;
  installed: boolean;
};

type PresetParam = {
  key: string;
  label: string;
  hint: string;
  default: string;
  examples: string[];
};

export type Preset = {
  id: string;
  broken?: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  author: string;
  roles: PresetRole[];
  params: PresetParam[];
  postInstall: string[];
};

export type InstallResult = {
  roleId: string;
  name: string;
  emoji?: string;
  markdownChars: number;
  workspaceFileCount: number;
  skillNames: string[];
  externalSkills: string[];
  exists: boolean;
  status: 'willCreate' | 'willUpdate' | 'willSkip' | 'created' | 'updated' | 'skipped' | 'failed';
  error?: string;
};

type PackAgentInfo = {
  id: string;
  name: string;
  skills: string[];
  fileCount: number;
  hasAutomations: boolean;
  hasMemory: boolean;
  conflict: boolean;
  nameConflict: boolean;
  soulPreview: string;
};

export type PackInspection = {
  kind: 'agent' | 'team';
  exportedAt: string;
  exportedBy?: { app?: string; version?: string };
  manifest: {
    name: string;
    summary: string;
    agentCount: number;
    skillCount: number;
    fileCount: number;
    totalBytes: number;
    includesMemory: boolean;
    includesAutomations: boolean;
    riskySkills: Array<{ agentId: string; skill: string; tools: string; exec: boolean; network: boolean }>;
    warnings: Array<{ code: string; detail?: string }>;
  };
  team: { id: string; name: string; conflict: boolean; members: Array<{ agentId: string }> } | null;
  agents: PackAgentInfo[];
  /** 包里附带的工作流摘要（P4a 起；旧后端不返回）。 */
  workflows?: Array<{ name: string; nodes: number; edges: number; valid: boolean; errorCode?: string }>;
};

export type InstallOutcome = {
  sourceId: string;
  targetId: string;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  fileCount?: number;
  skills?: string[];
  error?: string;
};

export type SessionSummary = { id: string; name: string };

export type GroupSummary = { id: string; name: string; members?: Array<{ agent_id: string }> };

export type Section = 'library' | 'import' | 'export';
