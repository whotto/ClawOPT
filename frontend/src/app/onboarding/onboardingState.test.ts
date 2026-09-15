import { describe, expect, it } from 'vitest';
import {
  isClientStale,
  resolveNoProviderPrompt,
  shouldRunStaleCheck,
  STALE_CHECK_MIN_INTERVAL_MS,
  type NoProviderInputs,
} from './onboardingState';

describe('isClientStale', () => {
  const build = { version: '1.9.0', buildTime: '2026-09-15T00:00:00.000Z' };

  it('same build is not stale', () => {
    expect(isClientStale(build, { ...build }, { dev: false })).toBe(false);
  });

  it('a different server build time or version is stale', () => {
    expect(isClientStale(build, { ...build, buildTime: '2026-09-16T00:00:00.000Z' }, { dev: false })).toBe(true);
    expect(isClientStale(build, { ...build, version: '1.10.0' }, { dev: false })).toBe(true);
  });

  it('never nags in dev mode or when either side lacks a build time', () => {
    const other = { version: '2.0.0', buildTime: '2027-01-01T00:00:00.000Z' };
    expect(isClientStale(build, other, { dev: true })).toBe(false);
    expect(isClientStale({ version: '1.9.0', buildTime: null }, other, { dev: false })).toBe(false);
    expect(isClientStale(build, { version: '2.0.0', buildTime: '' }, { dev: false })).toBe(false);
    expect(isClientStale(null, other, { dev: false })).toBe(false);
    expect(isClientStale(build, null, { dev: false })).toBe(false);
  });
});

describe('resolveNoProviderPrompt', () => {
  const empty: NoProviderInputs = {
    modelsLoaded: true,
    modelCount: 0,
    modelsConfigReadFailed: false,
    runtimesLoaded: true,
    availableRuntimeCount: 0,
    capabilitiesLoaded: true,
    canManageModels: true,
  };

  it('prompts admins to configure and members to ask an admin', () => {
    expect(resolveNoProviderPrompt(empty)).toBe('manage');
    expect(resolveNoProviderPrompt({ ...empty, canManageModels: false })).toBe('askAdmin');
  });

  it('stays hidden until every input has loaded (no flash)', () => {
    expect(resolveNoProviderPrompt({ ...empty, modelsLoaded: false })).toBe('hidden');
    expect(resolveNoProviderPrompt({ ...empty, runtimesLoaded: false })).toBe('hidden');
    expect(resolveNoProviderPrompt({ ...empty, capabilitiesLoaded: false })).toBe('hidden');
  });

  it('stays hidden when a model exists, a runtime is usable, or the data is unknown', () => {
    expect(resolveNoProviderPrompt({ ...empty, modelCount: 1 })).toBe('hidden');
    expect(resolveNoProviderPrompt({ ...empty, availableRuntimeCount: 1 })).toBe('hidden');
    expect(resolveNoProviderPrompt({ ...empty, availableRuntimeCount: null })).toBe('hidden');
    expect(resolveNoProviderPrompt({ ...empty, modelsConfigReadFailed: true })).toBe('hidden');
  });
});

describe('shouldRunStaleCheck', () => {
  it('throttles focus-driven checks but lets forced checks through', () => {
    expect(shouldRunStaleCheck(null, 1000, false)).toBe(true);
    expect(shouldRunStaleCheck(1000, 1000 + STALE_CHECK_MIN_INTERVAL_MS - 1, false)).toBe(false);
    expect(shouldRunStaleCheck(1000, 1000 + STALE_CHECK_MIN_INTERVAL_MS, false)).toBe(true);
    expect(shouldRunStaleCheck(1000, 1001, true)).toBe(true);
  });
});
