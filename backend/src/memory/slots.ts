/**
 * 受控种类 → 服务端槽位（spec 06 §4.3）。
 *
 * 模型只给「种类 + itemKey」，**规范键、领域、分类路径、类型都由这里决定**；调用方传来的 domain / category / type / key 一律忽略。
 * 单槽种类（一个作用域里只有一张 active 卡）不收 itemKey；多值种类必须给一个短而稳定的 itemKey。
 */
import { MemoryError, type MemoryCardType } from './types';

type ValueShape = 'text' | { fields: readonly string[]; required: readonly string[] };

export interface MemorySlot {
  kind: string;
  itemized: boolean;
  domain: string;
  categoryPath: string;
  type: MemoryCardType;
  value: ValueShape;
}

const TEXT: ValueShape = 'text';

const SLOT_LIST: MemorySlot[] = [
  // 单槽
  { kind: 'interaction_contract', itemized: false, domain: 'interaction', categoryPath: 'interaction/contract', type: 'preference', value: { fields: ['userRole', 'assistantRole', 'addressUserAs'], required: [] } },
  { kind: 'profile_name', itemized: false, domain: 'identity', categoryPath: 'identity/name', type: 'fact', value: TEXT },
  { kind: 'home_location', itemized: false, domain: 'identity', categoryPath: 'identity/location', type: 'fact', value: { fields: ['city', 'country'], required: ['city'] } },
  { kind: 'occupation', itemized: false, domain: 'identity', categoryPath: 'identity/occupation', type: 'fact', value: TEXT },
  { kind: 'timezone', itemized: false, domain: 'identity', categoryPath: 'identity/timezone', type: 'fact', value: TEXT },
  { kind: 'language', itemized: false, domain: 'communication', categoryPath: 'communication/language', type: 'preference', value: TEXT },
  // 多值
  { kind: 'accessibility_need', itemized: true, domain: 'accessibility', categoryPath: 'accessibility/need', type: 'constraint', value: TEXT },
  { kind: 'communication_preference', itemized: true, domain: 'communication', categoryPath: 'communication/preference', type: 'preference', value: TEXT },
  { kind: 'general_preference', itemized: true, domain: 'preference', categoryPath: 'preference/general', type: 'preference', value: TEXT },
  { kind: 'workflow_preference', itemized: true, domain: 'workflow', categoryPath: 'workflow/preference', type: 'preference', value: TEXT },
  { kind: 'tool_preference', itemized: true, domain: 'tools', categoryPath: 'tools/preference', type: 'preference', value: TEXT },
  { kind: 'relationship', itemized: true, domain: 'people', categoryPath: 'people/relationship', type: 'fact', value: TEXT },
  { kind: 'habit', itemized: true, domain: 'lifestyle', categoryPath: 'lifestyle/habit', type: 'fact', value: TEXT },
  { kind: 'environment_fact', itemized: true, domain: 'environment', categoryPath: 'environment/fact', type: 'fact', value: TEXT },
  { kind: 'project_context', itemized: true, domain: 'work', categoryPath: 'work/project', type: 'fact', value: TEXT },
  { kind: 'long_term_goal', itemized: true, domain: 'goals', categoryPath: 'goals/long_term', type: 'task', value: TEXT },
  { kind: 'durable_decision', itemized: true, domain: 'decisions', categoryPath: 'decisions/durable', type: 'decision', value: TEXT },
  { kind: 'hard_constraint', itemized: true, domain: 'constraints', categoryPath: 'constraints/hard', type: 'constraint', value: TEXT },
  { kind: 'food_avoidance', itemized: true, domain: 'health', categoryPath: 'health/food_avoidance', type: 'constraint', value: TEXT },
  { kind: 'custom_fact', itemized: true, domain: 'custom', categoryPath: 'custom/fact', type: 'fact', value: TEXT },
  { kind: 'active_task', itemized: true, domain: 'tasks', categoryPath: 'tasks/active', type: 'task', value: TEXT },
  { kind: 'recipe', itemized: true, domain: 'workflow', categoryPath: 'workflow/recipe', type: 'recipe', value: TEXT },
  { kind: 'correction', itemized: true, domain: 'corrections', categoryPath: 'corrections', type: 'correction', value: TEXT },
];

export const MEMORY_SLOTS: ReadonlyMap<string, MemorySlot> = new Map(SLOT_LIST.map((slot) => [slot.kind, slot]));
export const MEMORY_KINDS: readonly string[] = SLOT_LIST.map((slot) => slot.kind);

/** 每次召回都带上的种类（spec §4.5 (a)）；correction 卡另外全部带上。 */
export const ALWAYS_RECALLED_KINDS: ReadonlySet<string> = new Set(['interaction_contract', 'language', 'accessibility_need', 'communication_preference', 'hard_constraint']);

export function slotFor(kind: unknown): MemorySlot {
  const slot = typeof kind === 'string' ? MEMORY_SLOTS.get(kind) : undefined;
  if (!slot) throw new MemoryError('memoryService.unknownKind', `unknown memory kind: ${String(kind)}`, { kind: String(kind), allowed: MEMORY_KINDS.join(',') });
  return slot;
}

/** itemKey 归一：小写、空白与分隔符换成 `-`，只留字母数字、汉字、`-` `_`，最长 64。 */
export function normalizeItemKey(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.normalize('NFKC').toLowerCase().trim() : '';
  return text
    .replace(/[\s/\\.:,;，。、]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

export function canonicalKey(slot: MemorySlot, itemKey: unknown): string {
  if (!slot.itemized) return slot.kind;
  const normalized = normalizeItemKey(itemKey);
  if (!normalized) throw new MemoryError('memoryService.itemKeyRequired', `kind ${slot.kind} requires a short stable itemKey`, { kind: slot.kind });
  return `${slot.kind}:${normalized}`;
}

/** 校验并规整结构化值。文本种类的 value 可省（以 content 为准）。 */
export function normalizeValue(slot: MemorySlot, value: unknown): unknown {
  if (slot.value === 'text') {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new MemoryError('memoryService.invalidValue', `kind ${slot.kind} takes a string value`, { kind: slot.kind });
    return value.trim().slice(0, 2000) || null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MemoryError('memoryService.invalidValue', `kind ${slot.kind} takes an object value with ${slot.value.fields.join('/')}`, { kind: slot.kind });
  }
  const out: Record<string, string> = {};
  for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!slot.value.fields.includes(field)) {
      throw new MemoryError('memoryService.invalidValue', `kind ${slot.kind} has no field ${field}`, { kind: slot.kind, field });
    }
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' || !raw.trim()) throw new MemoryError('memoryService.invalidValue', `field ${field} must be a non-empty string`, { kind: slot.kind, field });
    out[field] = raw.trim().slice(0, 200);
  }
  for (const field of slot.value.required) {
    if (!out[field]) throw new MemoryError('memoryService.invalidValue', `kind ${slot.kind} requires ${field}`, { kind: slot.kind, field });
  }
  if (Object.keys(out).length === 0) throw new MemoryError('memoryService.invalidValue', `kind ${slot.kind} needs at least one field`, { kind: slot.kind });
  return out;
}
