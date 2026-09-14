import { describe, expect, it } from 'vitest';
import {
  joinDistinctLines,
  normalizeGatewayRestartTaskInfo,
  normalizePreviewTimeoutSeconds,
  parsePreviewTimeoutSecondsInput,
  parseTimestampMs,
  resolveStructuredErrorDisplay,
  responseNeedsHostTakeoverPasswordPrompt,
} from './settingsHelpers';

const t = (key: string) => (key === 'known.code' ? '已翻译' : key);

describe('normalizePreviewTimeoutSeconds', () => {
  it('clamps numbers and numeric strings into 5..3600', () => {
    expect(normalizePreviewTimeoutSeconds(1)).toBe(5);
    expect(normalizePreviewTimeoutSeconds(90.6)).toBe(91);
    expect(normalizePreviewTimeoutSeconds(99999)).toBe(3600);
    expect(normalizePreviewTimeoutSeconds('120')).toBe(120);
    expect(normalizePreviewTimeoutSeconds('2')).toBe(5);
  });

  it('falls back to 60 for anything unusable', () => {
    expect(normalizePreviewTimeoutSeconds(undefined)).toBe(60);
    expect(normalizePreviewTimeoutSeconds('abc')).toBe(60);
    expect(normalizePreviewTimeoutSeconds(Number.NaN)).toBe(60);
    expect(normalizePreviewTimeoutSeconds('   ')).toBe(60);
  });
});

describe('parsePreviewTimeoutSecondsInput', () => {
  it('accepts plain integers inside the range', () => {
    expect(parsePreviewTimeoutSecondsInput(' 5 ')).toBe(5);
    expect(parsePreviewTimeoutSecondsInput('3600')).toBe(3600);
  });

  it('rejects out-of-range, decimals, signs and text', () => {
    expect(parsePreviewTimeoutSecondsInput('4')).toBeNull();
    expect(parsePreviewTimeoutSecondsInput('3601')).toBeNull();
    expect(parsePreviewTimeoutSecondsInput('10.5')).toBeNull();
    expect(parsePreviewTimeoutSecondsInput('-10')).toBeNull();
    expect(parsePreviewTimeoutSecondsInput('')).toBeNull();
  });
});

describe('resolveStructuredErrorDisplay', () => {
  it('prefers a translated errorCode and keeps errorDetail as detail', () => {
    expect(resolveStructuredErrorDisplay({ errorCode: 'known.code', error: 'raw', errorDetail: ' stack ' }, t, 'fallback')).toEqual({
      message: '已翻译',
      detail: 'stack',
    });
  });

  it('falls through untranslated code → error → message', () => {
    expect(resolveStructuredErrorDisplay({ errorCode: 'unknown.code', error: ' boom ' }, t, 'fallback').message).toBe('boom');
    expect(resolveStructuredErrorDisplay({ message: 'msg' }, t, 'fallback').message).toBe('msg');
  });

  it('promotes detail to message when nothing else exists, else uses fallback key', () => {
    expect(resolveStructuredErrorDisplay({ errorDetail: 'only detail' }, t, 'fallback')).toEqual({ message: 'only detail', detail: '' });
    expect(resolveStructuredErrorDisplay({}, t, 'fallback')).toEqual({ message: 'fallback', detail: '' });
  });
});

describe('responseNeedsHostTakeoverPasswordPrompt', () => {
  it('detects the structured error code', () => {
    expect(responseNeedsHostTakeoverPasswordPrompt({ errorCode: 'gateway.hostTakeoverCredentialsRequired' })).toBe(true);
  });

  it('detects sudo password prompts in raw output', () => {
    expect(responseNeedsHostTakeoverPasswordPrompt({ errorDetail: 'sudo: a password is required' })).toBe(true);
    expect(responseNeedsHostTakeoverPasswordPrompt({ error: '[sudo] 密码：' })).toBe(true);
  });

  it('ignores unrelated failures', () => {
    expect(responseNeedsHostTakeoverPasswordPrompt({ errorDetail: 'ECONNREFUSED' })).toBe(false);
    expect(responseNeedsHostTakeoverPasswordPrompt({})).toBe(false);
  });
});

describe('joinDistinctLines / parseTimestampMs', () => {
  it('joins trimmed unique non-empty lines in order', () => {
    expect(joinDistinctLines([' a ', null, 'b', 'a', '', undefined, 'c'])).toBe('a\nb\nc');
  });

  it('parses ISO timestamps and rejects blanks and garbage', () => {
    expect(parseTimestampMs('2026-01-01T00:00:00.000Z')).toBe(Date.UTC(2026, 0, 1));
    expect(parseTimestampMs('  ')).toBeNull();
    expect(parseTimestampMs('not a date')).toBeNull();
    expect(parseTimestampMs(null)).toBeNull();
  });
});

describe('normalizeGatewayRestartTaskInfo', () => {
  it('returns null for non-objects', () => {
    expect(normalizeGatewayRestartTaskInfo(null)).toBeNull();
    expect(normalizeGatewayRestartTaskInfo('restarting')).toBeNull();
  });

  it('keeps known values and nulls out unknown or blank ones', () => {
    expect(normalizeGatewayRestartTaskInfo({
      status: 'restarting', trigger: 'browser-headed-mode', rawDetail: ' log ', startedAt: '', updatedAt: 'x', targetHeadedModeEnabled: true,
    })).toEqual({
      status: 'restarting', trigger: 'browser-headed-mode', rawDetail: 'log', startedAt: null, updatedAt: 'x', targetHeadedModeEnabled: true,
    });
    expect(normalizeGatewayRestartTaskInfo({ status: 'weird', trigger: 'other', targetHeadedModeEnabled: 'yes' })).toEqual({
      status: 'idle', trigger: null, rawDetail: null, startedAt: null, updatedAt: null, targetHeadedModeEnabled: null,
    });
  });
});
