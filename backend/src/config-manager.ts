import DB from './db';

interface Config {
  gatewayUrl: string;
  token?: string;
  password?: string;
  defaultAgent?: string;
  language?: 'zh-CN' | 'zh-TW' | 'en';
  aiName?: string;
  loginEnabled?: boolean;
  loginPassword?: string;
  allowedHosts?: string[];
  historyPageRounds?: number;
  previewConversionTimeoutSeconds?: number;
  sidebarFavorites?: {
    agents: string[];
    groups: string[];
    order: string[];
  };
}

function normalizeStoredStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string')))
    : [];
}

function normalizeSidebarFavorites(value: unknown): NonNullable<Config['sidebarFavorites']> {
  const agents = normalizeStoredStringArray((value as { agents?: unknown } | null | undefined)?.agents);
  const groups = normalizeStoredStringArray((value as { groups?: unknown } | null | undefined)?.groups);
  const fallbackOrder = [
    ...agents.map((id) => `agents:${id}`),
    ...groups.map((id) => `groups:${id}`),
  ];
  const allowedKeys = new Set(fallbackOrder);
  const parsedOrder = normalizeStoredStringArray((value as { order?: unknown } | null | undefined)?.order)
    .filter((entry) => allowedKeys.has(entry));

  return {
    agents,
    groups,
    order: [
      ...parsedOrder,
      ...fallbackOrder.filter((entry) => !parsedOrder.includes(entry)),
    ],
  };
}

function normalizeHistoryPageRounds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(100, Math.max(5, Math.round(value)));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(100, Math.max(5, parsed));
    }
  }

  return 30;
}

function normalizePreviewConversionTimeoutSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(3600, Math.max(5, Math.round(value)));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(3600, Math.max(5, parsed));
    }
  }

  return 60;
}

function normalizeConfigLanguage(value: unknown): NonNullable<Config['language']> {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase().replace(/_/g, '-') : '';

  if (
    normalized === 'zh-cn' ||
    normalized === 'zh-sg' ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-cn-') ||
    normalized.startsWith('zh-sg-') ||
    normalized.startsWith('zh-hans-')
  ) {
    return 'zh-CN';
  }

  if (
    normalized === 'zh-tw' ||
    normalized === 'zh-hk' ||
    normalized === 'zh-mo' ||
    normalized === 'zh-hant' ||
    normalized.startsWith('zh-tw-') ||
    normalized.startsWith('zh-hk-') ||
    normalized.startsWith('zh-mo-') ||
    normalized.startsWith('zh-hant-')
  ) {
    return 'zh-TW';
  }

  return 'en';
}

const DEFAULT_CONFIG: Config = {
  gatewayUrl: 'ws://127.0.0.1:18789',
  defaultAgent: 'main',
  language: 'zh-CN',
  aiName: 'OPT 团队',
  loginEnabled: false,
  loginPassword: '123456',
  allowedHosts: [],
  historyPageRounds: 30,
  previewConversionTimeoutSeconds: 60,
  sidebarFavorites: {
    agents: [],
    groups: [],
    order: [],
  },
};

export class ConfigManager {
  private db: DB;

  constructor() {
    this.db = new DB();
  }

  getConfig(): Config {
    const raw = this.db.getConfig('app_config');
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
      const parsed = JSON.parse(raw);
      const merged = {
        ...DEFAULT_CONFIG,
        ...parsed,
      };
      return {
        gatewayUrl: merged.gatewayUrl,
        token: merged.token,
        password: merged.password,
        defaultAgent: merged.defaultAgent,
        language: normalizeConfigLanguage(merged.language),
        aiName: merged.aiName,
        loginEnabled: merged.loginEnabled,
        loginPassword: merged.loginPassword,
        allowedHosts: normalizeStoredStringArray(merged.allowedHosts),
        historyPageRounds: normalizeHistoryPageRounds(merged.historyPageRounds),
        previewConversionTimeoutSeconds: normalizePreviewConversionTimeoutSeconds(merged.previewConversionTimeoutSeconds),
        sidebarFavorites: normalizeSidebarFavorites(merged.sidebarFavorites),
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  setConfig(newConfig: Partial<Config>): void {
    const merged = { ...this.getConfig(), ...newConfig };
    merged.language = normalizeConfigLanguage(merged.language);
    merged.historyPageRounds = normalizeHistoryPageRounds(merged.historyPageRounds);
    merged.previewConversionTimeoutSeconds = normalizePreviewConversionTimeoutSeconds(merged.previewConversionTimeoutSeconds);
    merged.sidebarFavorites = normalizeSidebarFavorites(merged.sidebarFavorites);
    this.db.setConfig('app_config', JSON.stringify(merged));
  }

  getGatewayUrl(): string {
    return this.getConfig().gatewayUrl;
  }

  getAuth(): { token?: string; password?: string } {
    const cfg = this.getConfig();
    return { token: cfg.token, password: cfg.password };
  }
}

export default ConfigManager;
export type { Config };
