import { describe, expect, it } from 'vitest';
import { deriveUpdateRestartStartedAtMs, normalizeUpdateRestartSteps, readPersistedUpdateRestartModalState } from './updateRestart';
import type { UpdateStatusInfo } from './settingsTypes';

describe('normalizeUpdateRestartSteps', () => {
  it('returns null for non-arrays', () => {
    expect(normalizeUpdateRestartSteps(undefined)).toBeNull();
    expect(normalizeUpdateRestartSteps({})).toBeNull();
  });

  it('always yields the three steps in fixed order, matching ids after trimming', () => {
    const steps = normalizeUpdateRestartSteps([
      { id: 'warmup_browser', status: 'running' },
      { id: ' restart_openclaw ', status: 'completed', detail: ' ok ', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(steps).toEqual([
      { id: 'restart_openclaw', status: 'completed', detail: 'ok', updatedAt: '2026-01-01T00:00:00Z' },
      { id: 'restart_project', status: 'pending', detail: null, updatedAt: null },
      { id: 'warmup_browser', status: 'running', detail: null, updatedAt: null },
    ]);
  });

  it('maps unrecognised statuses to pending (current behaviour, including "skipped")', () => {
    const steps = normalizeUpdateRestartSteps([{ id: 'warmup_browser', status: 'skipped' }]);
    expect(steps?.[2].status).toBe('pending');
  });
});

describe('deriveUpdateRestartStartedAtMs', () => {
  const base = { updatedAt: '2026-01-01T00:10:00Z', restartSteps: null } as unknown as UpdateStatusInfo;

  it('uses the earliest non-pending step time', () => {
    expect(deriveUpdateRestartStartedAtMs({
      ...base,
      restartSteps: [
        { id: 'restart_openclaw', status: 'completed', detail: null, updatedAt: '2026-01-01T00:05:00Z' },
        { id: 'restart_project', status: 'running', detail: null, updatedAt: '2026-01-01T00:03:00Z' },
        { id: 'warmup_browser', status: 'pending', detail: null, updatedAt: '2026-01-01T00:01:00Z' },
      ],
    })).toBe(Date.UTC(2026, 0, 1, 0, 3));
  });

  it('falls back to updatedAt, and null without an update', () => {
    expect(deriveUpdateRestartStartedAtMs(base)).toBe(Date.UTC(2026, 0, 1, 0, 10));
    expect(deriveUpdateRestartStartedAtMs(null)).toBeNull();
  });
});

describe('readPersistedUpdateRestartModalState', () => {
  it('returns null outside the browser', () => {
    expect(readPersistedUpdateRestartModalState()).toBeNull();
  });
});
