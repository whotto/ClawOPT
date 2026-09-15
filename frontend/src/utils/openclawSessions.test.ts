import { describe, expect, it } from 'vitest';
import { openclawSessionsOnly } from './openclawSessions';

describe('openclawSessionsOnly', () => {
  it('去掉外部运行时单聊，保留 OpenClaw 会话与顺序', () => {
    expect(openclawSessionsOnly([
      { id: 'a', agentId: 'main' },
      { id: 'cc', agentId: 'cc', externalRuntime: 'claude-code' },
      { id: 'b', agentId: 'writer', externalRuntime: '' },
    ]).map((s) => s.id)).toEqual(['a', 'b']);
  });
});
