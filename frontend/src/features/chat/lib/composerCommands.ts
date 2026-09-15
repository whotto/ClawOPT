// 输入框的「/」命令面板与引用回复（纯函数，带单测）。
//
// 命令面板 = 设置里的快捷命令 + 这个会话的运行时真正支持的会话命令。按能力决定显示哪些（`nativeCompact`），
// 不按运行时名字写 if；同名时快捷命令的说明优先（那是管理员写给团队的）。
//
// 引用回复的线格式：`<quoted_message sender="…">被引用的内容</quoted_message>` + 空行 + 回复。
// 被引用的是助手回复时去掉思考段；被引用的消息本身带引用时只引它的回复部分（不无限套娃）。命令从不带引用。

export type QuickCommand = { id: number; command: string; description: string };

export type SlashCommandSource = 'quick' | 'session';

export type SlashCommand = {
  id: number;
  command: string;
  description: string;
  source: SlashCommandSource;
};

export type SessionCommandContext = {
  /** 外部运行时单聊（Claude Code / Codex / Pi…）；null = OpenClaw 网关会话。 */
  externalRuntime: string | null;
  /** 外部运行时是否声明了原生压缩。 */
  nativeCompact: boolean;
};

/** 会话命令：key 是三语文案键 `slashCommands.<name>`。 */
export function sessionCommandsFor(context: SessionCommandContext): string[] {
  if (context.externalRuntime) {
    // 外部运行时：/status /usage /context 总是交给运行时；/compact 只在声明了原生压缩时显示。
    return [...(context.nativeCompact ? ['/compact'] : []), '/status', '/usage', '/context'];
  }
  // OpenClaw：网关的内建命令 + 经网关 sessions.compact 的压缩与按用量行算的 /usage /context。
  return ['/compact', '/usage', '/context', '/status', '/models', '/help', '/clear'];
}

export function mergeSlashCommands(
  quick: ReadonlyArray<QuickCommand>,
  context: SessionCommandContext,
  describe: (command: string) => string,
): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  sessionCommandsFor(context).forEach((command, index) => {
    byName.set(command, { id: -(index + 1), command, description: describe(command), source: 'session' });
  });
  for (const entry of quick) {
    const command = entry.command.trim().toLowerCase();
    if (!command.startsWith('/')) continue;
    const existing = byName.get(command);
    byName.set(command, { id: entry.id, command, description: entry.description || existing?.description || '', source: existing ? existing.source : 'quick' });
  }
  return [...byName.values()];
}

/** 输入「/co」：前缀匹配排前面，其余包含匹配在后；空查询全列。 */
export function filterSlashCommands<T extends { command: string }>(commands: ReadonlyArray<T>, input: string): T[] {
  const query = input.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!query || query === '/') return [...commands];
  const prefix = commands.filter((c) => c.command.toLowerCase().startsWith(query));
  const contains = commands.filter((c) => !c.command.toLowerCase().startsWith(query) && c.command.toLowerCase().includes(query.replace(/^\//, '')));
  return [...prefix, ...contains];
}

const QUOTE_PATTERN = /^\s*<quoted_message(?:\s+sender="([^"]*)")?>([\s\S]*?)<\/quoted_message>\s*/;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeAttribute(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** 被引用消息的正文：去掉思考段；它自己带引用时只取回复部分。 */
export function quotableContent(content: string, role: 'user' | 'assistant' | 'system'): string {
  let text = content;
  const nested = parseQuotedMessage(text);
  if (nested) text = nested.reply;
  if (role === 'assistant') text = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  return text.trim();
}

export function buildQuotedMessage(quote: { sender: string | null; content: string } | null, reply: string): string {
  const trimmedReply = reply.trim();
  if (!quote || trimmedReply.startsWith('/')) return trimmedReply;
  const senderAttribute = quote.sender ? ` sender="${escapeAttribute(quote.sender)}"` : '';
  // 引用内容里若出现结束标签，替换成全角斜杠，免得提前闭合。
  const body = quote.content.replace(/<\/quoted_message>/g, '<／quoted_message>');
  return `<quoted_message${senderAttribute}>${body}</quoted_message>\n\n${trimmedReply}`;
}

export function parseQuotedMessage(content: string): { sender: string | null; quoted: string; reply: string } | null {
  const match = QUOTE_PATTERN.exec(content);
  if (!match) return null;
  return {
    sender: match[1] !== undefined ? unescapeAttribute(match[1]) : null,
    quoted: match[2].trim(),
    reply: content.slice(match[0].length),
  };
}
