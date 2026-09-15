// 设置页的纯函数：输入校验、结构化错误展示、网关重启任务归一化。
import type { GatewayRestartTaskInfo } from './settingsTypes';

export const PREVIEW_TIMEOUT_MIN_SECONDS = 5;
export const PREVIEW_TIMEOUT_MAX_SECONDS = 3600;

export function normalizePreviewTimeoutSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(PREVIEW_TIMEOUT_MAX_SECONDS, Math.max(PREVIEW_TIMEOUT_MIN_SECONDS, Math.round(value)));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.min(PREVIEW_TIMEOUT_MAX_SECONDS, Math.max(PREVIEW_TIMEOUT_MIN_SECONDS, parsed));
    }
  }

  return 60;
}

export function parsePreviewTimeoutSecondsInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (parsed < PREVIEW_TIMEOUT_MIN_SECONDS || parsed > PREVIEW_TIMEOUT_MAX_SECONDS) {
    return null;
  }

  return parsed;
}

export function resolveStructuredErrorDisplay(
  data: { errorCode?: string; errorParams?: Record<string, string | number | boolean | null> | null; errorDetail?: string | null; error?: string; message?: string },
  t: (key: string, options?: any) => string,
  fallbackKey: string
): { message: string; detail: string } {
  let message = '';
  let detail = typeof data.errorDetail === 'string' && data.errorDetail.trim() ? data.errorDetail.trim() : '';

  if (data.errorCode) {
    const translated = t(data.errorCode, (data.errorParams || {}) as any);
    if (translated !== data.errorCode) {
      message = translated;
    }
  }

  if (!message && typeof data.error === 'string' && data.error.trim()) {
    message = data.error.trim();
  }

  if (!message && typeof data.message === 'string' && data.message.trim()) {
    message = data.message.trim();
  }

  if (!message && detail) {
    message = detail;
    detail = '';
  }

  return {
    message: message || t(fallbackKey),
    detail,
  };
}

export function responseNeedsHostTakeoverPasswordPrompt(data: {
  errorCode?: string;
  errorDetail?: string | null;
  error?: string;
  message?: string;
}) {
  if (data.errorCode === 'gateway.hostTakeoverCredentialsRequired') {
    return true;
  }

  const detail = [
    typeof data.errorDetail === 'string' ? data.errorDetail : '',
    typeof data.error === 'string' ? data.error : '',
    typeof data.message === 'string' ? data.message : '',
  ].join('\n').toLowerCase();

  const sudoPromptDetected = detail.includes('sudo:') || detail.includes('sudo：') || detail.includes('[sudo]');
  const passwordPromptDetected = detail.includes('password')
    || detail.includes('密码')
    || detail.includes('口令')
    || detail.includes('passphrase');
  const terminalPromptDetected = detail.includes('terminal') || detail.includes('终端');
  const authPromptDetected = detail.includes('authentication') || detail.includes('认证');

  return detail.includes('password is required')
    || detail.includes('a terminal is required')
    || detail.includes('no askpass program specified')
    || detail.includes('authentication is required')
    || detail.includes('需要密码')
    || detail.includes('需要提供密码')
    || detail.includes('需要输入密码')
    || detail.includes('密码是必需的')
    || detail.includes('必须输入密码')
    || detail.includes('需要口令')
    || detail.includes('需要终端')
    || detail.includes('需要认证')
    || (sudoPromptDetected && passwordPromptDetected)
    || (sudoPromptDetected && terminalPromptDetected)
    || (sudoPromptDetected && authPromptDetected);
}

export const CONNECTION_STATUS_REFRESH_EVENT = 'clawopt:refresh-connection-status';

export function joinDistinctLines(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(normalized);
  }
  return lines.join('\n');
}

export function parseTimestampMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeGatewayRestartTaskInfo(raw: unknown): GatewayRestartTaskInfo | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<GatewayRestartTaskInfo>;
  const status = typeof candidate.status === 'string' ? candidate.status : 'idle';
  const trigger = typeof candidate.trigger === 'string' ? candidate.trigger : null;

  return {
    status: status === 'restarting' || status === 'failed' ? status : 'idle',
    trigger: trigger === 'gateway' || trigger === 'browser-headed-mode' ? trigger : null,
    rawDetail: typeof candidate.rawDetail === 'string' && candidate.rawDetail.trim() ? candidate.rawDetail.trim() : null,
    startedAt: typeof candidate.startedAt === 'string' && candidate.startedAt.trim() ? candidate.startedAt.trim() : null,
    updatedAt: typeof candidate.updatedAt === 'string' && candidate.updatedAt.trim() ? candidate.updatedAt.trim() : null,
    targetHeadedModeEnabled: typeof candidate.targetHeadedModeEnabled === 'boolean' ? candidate.targetHeadedModeEnabled : null,
  };
}
