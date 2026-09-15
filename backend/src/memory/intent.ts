/**
 * 意图闸门（spec 06 §4.4 第 8 条）：看最近一条可信用户消息里有没有「记住」「忘掉」「全部忘掉」，中英文，识别否定句。
 *
 * **这是护栏，不是唯一的控制**（spec §6.3）：正则按语言写死、容易绕过，所以
 * - 写入策略（explicit-only）与作用域由宿主决定；
 * - 界面上人点的「记住 / 编辑 / 删除」带 `explicitUserAction`，不经这里；
 * - 否定判定宁可漏判意图（拒绝删除）也不误判（「别忘了……」绝不能被当成「忘掉」）。
 */

export type MemoryIntent = { remember: boolean; forget: boolean; forgetAll: boolean };

/** 按句拆开：一句里的否定只管这一句。 */
function clauses(text: string): string[] {
  return text.normalize('NFKC').split(/[。！？!?;；\n]+|[.,，](?=\s|$)|，/).map((part) => part.trim()).filter(Boolean);
}

const ZH_NEGATION = /(不要|不用|不必|无需|不需要|千万别|千万不要|请勿|不许|不能|不准|不会|别|勿|没有|没)\s*(再|去|帮我|给我|把)?\s*$/;
const EN_NEGATION = /\b(don't|dont|do not|never|no need to|not|stop|without)\s+(\w+\s+){0,2}$/i;

/** 在 `text` 里找 `pattern` 的每个命中，命中之前紧挨着的几个字不是否定词才算数。 */
function matchesUnnegated(text: string, pattern: RegExp, negation: RegExp, lookbehind = 12): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - lookbehind), match.index);
    if (!negation.test(before)) return true;
  }
  return false;
}

const ZH_REMEMBER = /记住|记下|记一下|记着|牢记|以后|从现在起|从今以后|从今往后|今后|更正|纠正|更新.{0,6}(记忆|偏好)/;
const EN_REMEMBER = /\bremember\b|\bfrom now on\b|\bgoing forward\b|\bin the future\b|\bupdate (your|my) memory\b|\bkeep in mind\b|\bmake a note\b|\bcorrection\b/i;

// 「我忘了带钥匙」是陈述，不是要求：第一人称 + 忘 不算。
const ZH_FIRST_PERSON_FORGOT = /我(已经|又|都|也|差点|竟然)?$/;
const ZH_FORGET = /忘掉|忘记|忘了|删(除|掉).{0,8}记忆|清(除|掉|空|理).{0,8}记忆|抹(掉|去).{0,8}记忆|别再记着/;
const EN_FORGET = /\bforget\b|\b(delete|clear|erase|wipe|remove|purge)\s+(\w+\s+){0,4}(memor(y|ies)|what you (know|remember))/i;

const ZH_ALL = /所有|全部|一切|统统|全都|都/;
const ZH_MEMORY_NOUN = /记忆|记住的|关于我的|你知道的/;
const EN_ALL = /\b(all|every|everything|entire)\b/i;
const EN_MEMORY_NOUN = /\bmemor(y|ies)\b|\beverything\b|\bwhat you (know|remember)\b|\babout me\b/i;

function zhForget(clause: string): boolean {
  const flags = 'g';
  for (const match of clause.matchAll(new RegExp(ZH_FORGET.source, flags))) {
    const before = clause.slice(Math.max(0, (match.index ?? 0) - 12), match.index);
    if (ZH_NEGATION.test(before)) continue;
    if (/^忘/.test(match[0]) && ZH_FIRST_PERSON_FORGOT.test(before)) continue;
    return true;
  }
  return false;
}

export function detectMemoryIntent(text: string | null | undefined): MemoryIntent {
  const result: MemoryIntent = { remember: false, forget: false, forgetAll: false };
  if (!text) return result;
  for (const clause of clauses(text)) {
    if (matchesUnnegated(clause, ZH_REMEMBER, ZH_NEGATION) || matchesUnnegated(clause, EN_REMEMBER, EN_NEGATION)) result.remember = true;
    const forget = zhForget(clause) || matchesUnnegated(clause, EN_FORGET, EN_NEGATION, 24);
    if (!forget) continue;
    result.forget = true;
    const all = (ZH_ALL.test(clause) && ZH_MEMORY_NOUN.test(clause)) || (EN_ALL.test(clause) && EN_MEMORY_NOUN.test(clause));
    if (all) result.forgetAll = true;
  }
  return result;
}

/** 查询里「列出全部」的说法：按枚举处理，不按相关度排。 */
export function isListAllQuery(query: string | undefined): boolean {
  if (!query) return false;
  return /^(all|everything|\*)$/i.test(query.trim())
    || /\b(list|show)\s+(me\s+)?(all|every)\b.*\bmemor/i.test(query)
    || /\ball\s+(your\s+)?memor(y|ies)\b/i.test(query)
    || /(所有|全部)(的)?记忆|列出.{0,4}(所有|全部)|你(都)?记得(些)?什么/.test(query);
}
