import { describe, expect, it } from 'vitest';
import { formatLiveDuration, groupTracesByMessage, summarizeToolRun } from './toolTrace';

describe('toolTrace', () => {
  it('摘要：名字按首次出现去重，前 3 个 + 剩余数；失败与中断分开', () => {
    const calls = [
      { name: 'Bash', status: 'completed' as const },
      { name: 'Read', status: 'completed' as const },
      { name: 'Bash', status: 'failed' as const },
      { name: 'Edit', status: 'interrupted' as const },
      { name: 'Grep', status: 'completed' as const },
    ];
    expect(summarizeToolRun(calls)).toEqual({ total: 5, names: ['Bash', 'Read', 'Edit'], more: 1, failed: 1, interrupted: 1 });
  });

  it('按消息分组，没有调用的运行不出卡', () => {
    const grouped = groupTracesByMessage([
      { messageId: 5, runMarker: 'a', calls: [{ id: 1 } as any] },
      { messageId: 6, runMarker: 'b', calls: [] },
    ]);
    expect([...grouped.keys()]).toEqual(['5']);
  });

  it('实时计时显示', () => {
    expect(formatLiveDuration(12_400)).toBe('12s');
    expect(formatLiveDuration(65_000)).toBe('1m 05s');
  });
});
