import { describe, expect, it } from 'vitest';
import { applySettingsAreaLoading, EMPTY_SETTINGS_LOADING, isSettingsAreaLoading } from './settingsLoading';

describe('settings loading areas', () => {
  it('a request in one area does not mark any other area as loading', () => {
    const state = applySettingsAreaLoading(EMPTY_SETTINGS_LOADING, 'models', true);
    expect(isSettingsAreaLoading(state, 'models')).toBe(true);
    expect(isSettingsAreaLoading(state, 'gateway')).toBe(false);
    expect(isSettingsAreaLoading(state, 'general')).toBe(false);
    expect(isSettingsAreaLoading(state, 'commands')).toBe(false);
  });

  it('overlapping requests in the same area stay loading until the last one ends', () => {
    let state = applySettingsAreaLoading(EMPTY_SETTINGS_LOADING, 'gateway', true);
    state = applySettingsAreaLoading(state, 'gateway', true);
    state = applySettingsAreaLoading(state, 'gateway', false);
    expect(isSettingsAreaLoading(state, 'gateway')).toBe(true);
    state = applySettingsAreaLoading(state, 'gateway', false);
    expect(isSettingsAreaLoading(state, 'gateway')).toBe(false);
  });

  it('an unmatched end never goes below idle and keeps the same object', () => {
    expect(applySettingsAreaLoading(EMPTY_SETTINGS_LOADING, 'general', false)).toBe(EMPTY_SETTINGS_LOADING);
  });
});
