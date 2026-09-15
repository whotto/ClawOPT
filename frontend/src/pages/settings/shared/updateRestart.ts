// 升级后重启弹窗的步骤归一化与 localStorage 持久化（刷新页面后仍能接回重启进度）。
import type { PersistedUpdateRestartModalState, UpdateRestartStep, UpdateRestartStepId, UpdateStatusInfo } from './settingsTypes';
import { parseTimestampMs } from './settingsHelpers';

export const UPDATE_RESTART_MODAL_TIMEOUT_MS = 5 * 60 * 1000;
const UPDATE_RESTART_MODAL_STORAGE_KEY = 'clawopt:update-restart-modal';
export const UPDATE_RESTART_STEP_IDS: UpdateRestartStepId[] = [
  'restart_openclaw',
  'restart_project',
  'warmup_browser',
];

export const normalizeUpdateRestartSteps = (raw: unknown): UpdateRestartStep[] | null => {
  if (!Array.isArray(raw)) return null;

  return UPDATE_RESTART_STEP_IDS.map((id) => {
    const matched = raw.find((entry) => (
      entry
      && typeof entry === 'object'
      && typeof (entry as { id?: unknown }).id === 'string'
      && (entry as { id: string }).id.trim() === id
    )) as { status?: unknown; detail?: unknown; updatedAt?: unknown } | undefined;

    const status = typeof matched?.status === 'string' ? matched.status.trim() : '';
    return {
      id,
      status: status === 'running' || status === 'completed' || status === 'failed' ? status : 'pending',
      detail: typeof matched?.detail === 'string' && matched.detail.trim() ? matched.detail.trim() : null,
      updatedAt: typeof matched?.updatedAt === 'string' && matched.updatedAt.trim() ? matched.updatedAt.trim() : null,
    };
  });
};

export const deriveUpdateRestartStartedAtMs = (update: UpdateStatusInfo | null) => {
  if (!update) return null;

  const stepTimes = (normalizeUpdateRestartSteps(update.restartSteps) || [])
    .filter((step) => step.status !== 'pending')
    .map((step) => parseTimestampMs(step.updatedAt))
    .filter((value): value is number => value !== null);

  if (stepTimes.length) {
    return Math.min(...stepTimes);
  }

  return parseTimestampMs(update.updatedAt);
};

export const readPersistedUpdateRestartModalState = (): PersistedUpdateRestartModalState | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(UPDATE_RESTART_MODAL_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PersistedUpdateRestartModalState>;
    if (parsed.stage !== 'restarting') {
      return null;
    }

    const startedAtMs = typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
      ? parsed.startedAtMs
      : null;
    return {
      stage: 'restarting',
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      stepSnapshot: normalizeUpdateRestartSteps(parsed.stepSnapshot),
      startedAtMs,
    };
  } catch {
    return null;
  }
};

export const writePersistedUpdateRestartModalState = (state: PersistedUpdateRestartModalState | null) => {
  if (typeof window === 'undefined') {
    return;
  }

  if (!state) {
    window.localStorage.removeItem(UPDATE_RESTART_MODAL_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(UPDATE_RESTART_MODAL_STORAGE_KEY, JSON.stringify(state));
};

export const isPersistedUpdateRestartModalStateFresh = (state: PersistedUpdateRestartModalState | null) => {
  if (!state?.startedAtMs) {
    return true;
  }

  return Date.now() - state.startedAtMs <= UPDATE_RESTART_MODAL_TIMEOUT_MS + 60 * 1000;
};
