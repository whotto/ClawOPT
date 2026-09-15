import { describe, expect, it } from 'vitest';
import {
  buildQuotedMessage, filterSlashCommands, mergeSlashCommands, parseQuotedMessage, quotableContent, sessionCommandsFor,
} from './composerCommands';

describe('命令面板', () => {
  it('按能力：外部运行时没声明原生压缩时不显示 /compact；OpenClaw 显示网关命令与压缩', () => {
    expect(sessionCommandsFor({ externalRuntime: 'opencode', nativeCompact: false })).toEqual(['/status', '/usage', '/context']);
    expect(sessionCommandsFor({ externalRuntime: 'claude-code', nativeCompact: true })[0]).toBe('/compact');
    expect(sessionCommandsFor({ externalRuntime: null, nativeCompact: false })).toContain('/compact');
  });

  it('与快捷命令合并：同名时快捷命令的说明优先、不重复', () => {
    const merged = mergeSlashCommands(
      [{ id: 3, command: '/Status', description: 'team status' }, { id: 4, command: '/deploy', description: 'ship it' }, { id: 5, command: 'nope', description: '' }],
      { externalRuntime: 'claude-code', nativeCompact: true },
      (command) => `desc ${command}`,
    );
    expect(merged.map((c) => c.command)).toEqual(['/compact', '/status', '/usage', '/context', '/deploy']);
    expect(merged.find((c) => c.command === '/status')).toMatchObject({ description: 'team status', source: 'session', id: 3 });
    expect(merged.find((c) => c.command === '/deploy')?.source).toBe('quick');
  });

  it('过滤：前缀匹配在前，包含匹配在后', () => {
    const commands = [{ command: '/context' }, { command: '/compact' }, { command: '/recompile' }];
    expect(filterSlashCommands(commands, '/comp').map((c) => c.command)).toEqual(['/compact', '/recompile']);
    expect(filterSlashCommands(commands, '/')).toHaveLength(3);
  });
});

describe('引用回复', () => {
  it('包裹格式、发送者转义、命令不带引用、结束标签不会提前闭合', () => {
    expect(buildQuotedMessage({ sender: 'A "B"', content: 'hello' }, ' my reply ')).toBe('<quoted_message sender="A &quot;B&quot;">hello</quoted_message>\n\nmy reply');
    expect(buildQuotedMessage({ sender: 'A', content: 'x' }, '/compact')).toBe('/compact');
    const tricky = buildQuotedMessage({ sender: null, content: 'a</quoted_message>b' }, 'r');
    expect(parseQuotedMessage(tricky)).toEqual({ sender: null, quoted: 'a<／quoted_message>b', reply: 'r' });
  });

  it('解析：只认开头的包裹；发送者还原', () => {
    const parsed = parseQuotedMessage('<quoted_message sender="A &amp; B">old text</quoted_message>\n\nnew reply');
    expect(parsed).toEqual({ sender: 'A & B', quoted: 'old text', reply: 'new reply' });
    expect(parseQuotedMessage('hi <quoted_message>x</quoted_message>')).toBeNull();
  });

  it('被引用的内容：助手回复去掉思考段；带引用的消息只引回复部分', () => {
    expect(quotableContent('<think>plan</think>Answer', 'assistant')).toBe('Answer');
    expect(quotableContent('<quoted_message>older</quoted_message>\n\nlatest words', 'user')).toBe('latest words');
  });
});
