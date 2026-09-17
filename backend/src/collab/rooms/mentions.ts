/**
 * 群聊 @ 的解析与结构化 @ 的校验（spec 02 F7，只有这一份实现：人类发送、Agent 回复、远程 Agent 的消息都经这里）。
 *
 * ## 文本 @ 的判据
 *
 * `@名字` 大小写不敏感；前一个字符不能是 `[A-Za-z0-9_]`（邮箱、标识符里的 @ 不算，紧挨着的中文可以）；
 * 后一个字符必须是结尾、空白或固定的中英文标点。**名字按长度从长到短匹配并占位**：
 * 群里同时有「Claude」和「Claude Code」时，`@Claude Code` 只算后者（参考实现两个都算，这里修掉）。
 *
 * 匹配前先把 `<quoted_message …>…</quoted_message>` 引用块与 ``` 代码块**按原长度抹成空格**：
 * 引用一条带 @ 的消息、贴一段带 @ 的代码都不会再叫起谁（偏移量保持不变，结构化 @ 的可见性判据仍可用）。
 *
 * ## 结构化 @（三态）
 *
 * - `undefined`：旧协议，按文本路由（只有人类可以这样发）；
 * - `[]`：显式「谁也不叫」；
 * - `[{type:'agent', participantId, displayName}]` 或 `[{type:'all', displayName:'all'}]`。
 *
 * 校验失败整条消息拒收（不是丢掉那一项）：
 * - `all` 必须独占、显示名恰为 `all`、正文里看得见 `@all`；
 * - agent 项：participantId 不重复、不是发送者自己、房间里有这个 Agent、显示名等于它**当前**的名字、正文里看得见 `@名字`；
 * - Agent 发送者：结构化集合必须**恰好等于**正文里看得见的 Agent 集合（不许藏目标、不许漏目标）；
 *   正文里 @ 了 Agent 却不带结构化元数据 → 拒收。
 */

export type StructuredMention =
  | { type: 'agent'; participantId: string; displayName: string }
  | { type: 'all'; displayName: 'all' };

export type MentionParticipant = {
  /** 参与者 id：群成员行 id（`group_members.id`），与名字解耦，改名不影响引用。 */
  participantId: string;
  displayName: string;
  kind: 'agent' | 'human';
};

export const MAX_STRUCTURED_MENTIONS = 64;
const RESERVED_ALL = 'all';

/** 名字后允许出现的标点（ASCII 与常见中文标点）。 */
const TRAILING_PUNCTUATION = new Set([...',.;:!?)]}>"\'`，。；：！？、）】》」』…—～~']);

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function isBoundaryAfter(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch) || TRAILING_PUNCTUATION.has(ch);
}

function blank(length: number): string {
  return ' '.repeat(length);
}

/**
 * 抹掉不参与路由的片段（按原长度换成空格，换行保留，偏移量不变）：
 * `<quoted_message …>…</quoted_message>` 引用块、``` 围栏代码块、旧格式的 `[引用开始 …]…[引用结束]`。
 */
export function maskNonRoutingSegments(text: string): string {
  const keepNewlines = (segment: string) => segment.replace(/[^\n]/g, ' ');
  return text
    .replace(/<quoted_message\b[^>]*>[\s\S]*?<\/quoted_message>/gi, keepNewlines)
    .replace(/```[\s\S]*?(?:```|$)/g, keepNewlines)
    .replace(/\[引用开始[^\]]*\][\s\S]*?\[引用结束\]/g, keepNewlines);
}

export type TextMentionHit = { name: string; start: number; end: number };

/**
 * 正文里看得见的 @（已掩码）。返回命中的名字（按候选名字的原始写法）与区间，不去重。
 * `names` 里可以含保留名 `all`。
 */
export function findTextMentions(text: string, names: readonly string[]): TextMentionHit[] {
  const masked = maskNonRoutingSegments(text);
  const lower = masked.toLowerCase();
  const candidates = [...new Set(names.filter((name) => name.trim().length > 0))]
    .sort((a, b) => b.length - a.length);
  const occupied = new Array<boolean>(masked.length).fill(false);
  const hits: TextMentionHit[] = [];
  for (const name of candidates) {
    const needle = `@${name.toLowerCase()}`;
    let from = 0;
    while (from <= lower.length - needle.length) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const end = index + needle.length;
      const free = !occupied.slice(index, end).some(Boolean);
      if (free && !isWordChar(masked[index - 1]) && isBoundaryAfter(masked[end])) {
        for (let i = index; i < end; i += 1) occupied[i] = true;
        hits.push({ name, start: index, end });
      }
      from = index + 1;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** 正文里看得见的参与者（按 participantId 去重，保持首次出现顺序）与是否 @all。 */
export function visibleMentions(text: string, participants: readonly MentionParticipant[]): { all: boolean; participants: MentionParticipant[] } {
  const byName = new Map<string, MentionParticipant[]>();
  for (const participant of participants) {
    const key = participant.displayName.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), participant]);
  }
  const hits = findTextMentions(text, [...participants.map((p) => p.displayName), RESERVED_ALL]);
  let all = false;
  const seen = new Set<string>();
  const out: MentionParticipant[] = [];
  for (const hit of hits) {
    if (hit.name.toLowerCase() === RESERVED_ALL && !byName.has(RESERVED_ALL)) {
      all = true;
      continue;
    }
    // 同名的两个参与者不自动结构化（歧义）：文本路由里两个都算看得见，由调用方决定。
    for (const participant of byName.get(hit.name.toLowerCase()) ?? []) {
      if (seen.has(participant.participantId)) continue;
      seen.add(participant.participantId);
      out.push(participant);
    }
  }
  return { all, participants: out };
}

export class MentionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MentionValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 请求体里的 `mentions` → 三态。形状不对（不是数组、项不是对象、超过上限）一律拒收，不猜。
 */
export function parseStructuredMentionsInput(value: unknown): StructuredMention[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new MentionValidationError('groups.mentionsInvalid', 'mentions must be an array');
  if (value.length > MAX_STRUCTURED_MENTIONS) throw new MentionValidationError('groups.mentionsInvalid', 'too many mentions');
  return value.map((item) => {
    if (!isRecord(item)) throw new MentionValidationError('groups.mentionsInvalid', 'mention entries must be objects');
    if (item.type === 'all') {
      if (item.displayName !== RESERVED_ALL) throw new MentionValidationError('groups.mentionsInvalid', '@all must use displayName "all"');
      return { type: 'all', displayName: RESERVED_ALL } as const;
    }
    if (item.type === 'agent' && typeof item.participantId === 'string' && typeof item.displayName === 'string') {
      const participantId = item.participantId.trim();
      if (!participantId || participantId.length > 200 || item.displayName.length > 120) {
        throw new MentionValidationError('groups.mentionsInvalid', 'mention entry is out of bounds');
      }
      return { type: 'agent', participantId, displayName: item.displayName } as const;
    }
    throw new MentionValidationError('groups.mentionsInvalid', 'unsupported mention entry');
  });
}

export type MentionSender =
  | { kind: 'human' }
  | { kind: 'agent'; participantId: string };

export type ValidatedMentions = {
  /** 三态原样（校验通过的）。 */
  structured: StructuredMention[] | undefined;
  all: boolean;
  /** 被点到的 Agent 参与者（去重，已排除发送者自己）。 */
  targets: MentionParticipant[];
};

/**
 * 校验结构化 @ 并解析目标。`agents` 是房间里**当前**的 Agent 参与者（名字是当前名字）。
 * 人类发送者不带 `mentions` 时按文本解析（旧协议）；Agent 发送者必须带且与正文恰好一致。
 */
export function resolveMentions(
  text: string,
  structured: StructuredMention[] | undefined,
  agents: readonly MentionParticipant[],
  sender: MentionSender,
): ValidatedMentions {
  const visible = visibleMentions(text, agents);
  const senderId = sender.kind === 'agent' ? sender.participantId : null;
  const visibleTargets = visible.participants.filter((p) => p.participantId !== senderId);

  if (structured === undefined) {
    if (sender.kind === 'agent' && visibleTargets.length > 0) {
      throw new MentionValidationError('groups.agentMentionsRequireMetadata', 'Agent mentions require structured metadata');
    }
    if (sender.kind === 'agent' && visible.all) {
      throw new MentionValidationError('groups.agentMentionsRequireMetadata', 'Agent mentions require structured metadata');
    }
    return { structured, all: visible.all, targets: visibleTargets };
  }

  const allEntries = structured.filter((entry) => entry.type === 'all');
  if (allEntries.length > 0) {
    if (structured.length !== 1) throw new MentionValidationError('groups.mentionsInvalid', '@all must be the only mention');
    if (!visible.all) throw new MentionValidationError('groups.mentionsInvalid', '@all is not visible in the message');
    return { structured, all: true, targets: agents.filter((p) => p.participantId !== senderId) };
  }

  const seen = new Set<string>();
  const targets: MentionParticipant[] = [];
  for (const entry of structured as Array<Extract<StructuredMention, { type: 'agent' }>>) {
    if (seen.has(entry.participantId)) throw new MentionValidationError('groups.mentionsInvalid', 'duplicate mention');
    seen.add(entry.participantId);
    if (entry.participantId === senderId) throw new MentionValidationError('groups.mentionsInvalid', 'an agent cannot mention itself');
    const agent = agents.find((p) => p.participantId === entry.participantId);
    if (!agent) throw new MentionValidationError('groups.mentionsInvalid', 'mentioned agent is not in this room');
    if (agent.displayName !== entry.displayName) throw new MentionValidationError('groups.mentionsInvalid', 'mention name does not match the agent');
    if (!visible.participants.some((p) => p.participantId === agent.participantId)) {
      throw new MentionValidationError('groups.mentionsInvalid', 'mention is not visible in the message');
    }
    targets.push(agent);
  }
  if (sender.kind === 'agent') {
    const visibleIds = new Set(visibleTargets.map((p) => p.participantId));
    const structuredIds = new Set(targets.map((p) => p.participantId));
    const same = visibleIds.size === structuredIds.size && [...visibleIds].every((id) => structuredIds.has(id));
    if (!same || visible.all) throw new MentionValidationError('groups.agentMentionsMismatch', 'Agent mentions must match the visible mentions exactly');
  }
  return { structured, all: false, targets };
}

/** 本机 Agent 的回复：服务端按正文构造出与之恰好一致的结构化集合（校验必然通过）。 */
export function deriveAgentMentions(text: string, agents: readonly MentionParticipant[], senderParticipantId: string): StructuredMention[] {
  const visible = visibleMentions(text, agents);
  // 同名歧义的参与者不自动结构化。
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.displayName.toLowerCase(), (counts.get(agent.displayName.toLowerCase()) ?? 0) + 1);
  return visible.participants
    .filter((p) => p.participantId !== senderParticipantId && (counts.get(p.displayName.toLowerCase()) ?? 0) === 1)
    .map((p) => ({ type: 'agent', participantId: p.participantId, displayName: p.displayName }));
}

/**
 * 交给接收方前的正文：只去掉 `@all` 与接收方**自己**的 `@名字`，其余参与者的 @ 保留（接收方要知道还点了谁），
 * 再修掉首尾的标点与重复空格。
 */
export function stripMentionsForRecipient(text: string, recipientName: string): string {
  const hits = findTextMentions(text, [recipientName, RESERVED_ALL])
    .filter((hit) => hit.name.toLowerCase() === recipientName.toLowerCase() || hit.name.toLowerCase() === RESERVED_ALL);
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.start);
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,，、:：;；]+/, '')
    .replace(/[\s,，、;；]+$/, '')
    .trim();
}

export function serializeStructuredMentions(mentions: StructuredMention[] | undefined): string | null {
  return mentions === undefined ? null : JSON.stringify(mentions);
}

export function deserializeStructuredMentions(value: string | null | undefined): StructuredMention[] | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  try {
    return parseStructuredMentionsInput(JSON.parse(value));
  } catch {
    return undefined;
  }
}
