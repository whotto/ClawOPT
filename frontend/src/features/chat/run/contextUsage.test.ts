import { describe, expect, it } from 'vitest';
import { formatTokenCount, normalizeContextUsage, usageTone } from './contextUsage';

describe('contextUsage', () => {
  it('数字压缩不带多余的 .0', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(12_345)).toBe('12.3k');
    expect(formatTokenCount(200_000)).toBe('200k');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
  });

  it('颜色档位：>60% 提醒、>80% 危险；没有窗口不着色', () => {
    expect(usageTone(60)).toBe('normal');
    expect(usageTone(60.1)).toBe('warn');
    expect(usageTone(80.5)).toBe('danger');
    expect(usageTone(null)).toBe('normal');
  });

  it('接口失败或形状不对：不显示', () => {
    expect(normalizeContextUsage({ success: false })).toBeNull();
    expect(normalizeContextUsage({ success: true, usedTokens: 5, contextWindow: null, percent: null })).toEqual({ usedTokens: 5, contextWindow: null, percent: null, approximate: false });
  });
});
