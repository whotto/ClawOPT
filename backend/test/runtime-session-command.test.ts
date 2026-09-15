/**
 * 契约事件 `session.command`（会话命令结果 / 运行中途的压缩完成）。
 *
 * 此前压缩结果借道 `plan.updated {kind: 'compact_boundary'}`、status / usage 结果是塞进 outputText 的 JSON：
 * 计划面板会把它当步骤显示，正文里出现一段 JSON，界面也没法本地化。
 * 这里钉住：协调器按控制事件转发（进重放缓冲、不碰计划的 replace 槽）；单聊落库与读历史都走结构化消息通道。
 */
import { describe, expect, it } from 'vitest';
import { RealtimeHub, type RealtimeEvent } from '../src/core/realtime';
import { RunCoordinator } from '../src/runtime/coordinator';
import { facetOf } from '../src/runtime/contract';
import {
  buildCommandResultFrame,
  describeCommandResult,
  parseCommandResultContent,
  serializeCommandResultContent,
} from '../src/collab/sessions/chat-command-result';
import { createChatMessages } from '../src/collab/sessions/chat-messages';
import { MemoryRunStore, flush, scriptedAdapter } from './helpers/scripted-adapter';

describe('session.command 经协调器', () => {
  it('是控制事件：原样发到主题、进重放缓冲；不再冒充 plan.updated', async () => {
    const hub = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    hub.listen('session-command', (event) => events.push(event));
    const coordinator = new RunCoordinator({ hub, store: new MemoryRunStore(), log: () => {} });
    const { adapter, runs } = scriptedAdapter();
    const submitted: any = await coordinator.submit({ sessionKey: 's1', surface: 'chat', topics: ['session:s1'], agentId: 'a', adapter, request: {}, projector: () => ({ onEvent: () => {}, finish: () => ({}) }) }, 'reject');
    await flush();
    const result = { command: 'compact' as const, ok: true, compaction: { trigger: 'manual' as const, preTokens: 50000, postTokens: 9000 } };
    expect(facetOf({ type: 'session.command', result })).toBe('control');
    runs[0].emit({ type: 'session.command', result });
    const snapshot = coordinator.snapshot('s1');
    runs[0].finish({ kind: 'completed' });
    await submitted.completion;
    const published = events.filter((event) => event.type === 'session.command');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ topic: 'session:s1', payload: result });
    expect(events.some((event) => event.type === 'plan.updated')).toBe(false);
    expect(snapshot.replay.map((entry: any) => entry.type ?? entry.event?.type)).toContain('session.command');
  });
});

describe('单聊落库与读历史：结构化消息，不是某种语言的句子', () => {
  const { withStructuredChatMessage } = createChatMessages({ sessionRuntime: { getSessionWorkspacePath: () => '/tmp/ws' } as any });

  it('压缩 / 状态 / 用量 / 失败各有自己的码与参数，缺的数字显示为 —', () => {
    expect(describeCommandResult({ command: 'compact', ok: true, compaction: { trigger: 'auto', preTokens: 120000 } })).toMatchObject({
      role: 'system', messageCode: 'runtimeCommand.compactDone', messageParams: { trigger: 'auto', preTokens: 120000, postTokens: '—' },
    });
    expect(describeCommandResult({ command: 'status', ok: true, status: { model: 'm', autoCompaction: true } }).messageParams).toMatchObject({ model: 'm', nativeSessionId: '—', autoCompaction: 'on' });
    expect(describeCommandResult({ command: 'usage', ok: true, usage: { inputTokens: 1, costUsd: 0.123456, contextPercent: 12.345 } }).messageParams).toMatchObject({ inputTokens: 1, costUsd: 0.1235, contextPercent: 12.3, contextWindow: '—' });
    expect(describeCommandResult({ command: 'compact', ok: false, error: 'boom' })).toMatchObject({ messageCode: 'runtimeCommand.failed', messageParams: { command: 'compact', error: 'boom' }, rawDetail: 'boom' });
  });

  it('落库内容读回来仍是同一条结构化消息；帧与历史给出同样的码', () => {
    const result = { command: 'compact' as const, ok: true, compaction: { trigger: 'manual' as const, preTokens: 50000, postTokens: 9000, summary: '摘要' } };
    const content = serializeCommandResultContent(result);
    const row = withStructuredChatMessage({ content, role: 'system' as const, agent_id: 'codex-agent', agent_name: 'Codex' });
    const frame = buildCommandResultFrame(result);
    expect(row).toMatchObject({ role: 'system', messageCode: 'runtimeCommand.compactDone', messageParams: frame.messageParams, rawDetail: '摘要', content: frame.text });
    expect(frame).toMatchObject({ type: 'final', role: 'system', messageCode: 'runtimeCommand.compactDone' });
    expect(parseCommandResultContent('⌘ {not json')).toBeNull();
    expect(parseCommandResultContent('plain text')).toBeNull();
  });
});
