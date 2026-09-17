import { describe, expect, it } from 'vitest';
import { DEFAULT_REFRESH_MS, formatBytes, formatDuration, normalizeRefreshInterval, usageTone } from './performanceFormat';

describe('性能页格式', () => {
  it('字节', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(null)).toBe('—');
  });

  it('时长', () => {
    expect(formatDuration(59)).toBe('0m 59s');
    expect(formatDuration(3700)).toBe('1h 1m');
    expect(formatDuration(90000)).toBe('1d 1h');
  });

  it('占用率色调与刷新间隔', () => {
    expect([usageTone(10), usageTone(70), usageTone(95), usageTone(null)]).toEqual(['green', 'amber', 'red', 'gray']);
    expect(normalizeRefreshInterval(2000)).toBe(2000);
    expect(normalizeRefreshInterval('7000')).toBe(DEFAULT_REFRESH_MS);
  });
});
