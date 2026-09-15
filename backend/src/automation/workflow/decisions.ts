/**
 * 判定：边的路由 + 条件，节点的汇合。全部是纯函数。
 *
 * 条件运算符**强类型、不做隐式转换**：`"5" greater_than 3` 为假；contains 遇到非字符串非数组，
 * contains 与 not_contains **都为假**（不是互为取反）——拿不准就不放行，朝安全的方向失败。
 */
import { FORBIDDEN_PATH_SEGMENTS } from './normalize';
import type { ConditionEvaluation, EdgeCondition, EdgeDecision, EdgeOrchestration, JoinMode, SourceOutcome } from './types';

export type DecisionContext = { output?: string; outputJson?: unknown; error?: string };

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function evaluateCondition(condition: EdgeCondition, context: DecisionContext): ConditionEvaluation {
  const segments = condition.path.split('.');
  if (segments.some((segment) => !segment || FORBIDDEN_PATH_SEGMENTS.has(segment))) {
    return { status: 'not_matched', reason: 'path_not_found' };
  }
  let current: unknown = context;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !hasOwn(current, segment)) {
      return condition.operator === 'not_exists'
        ? { status: 'matched', reason: 'path_not_found' }
        : { status: 'not_matched', reason: 'path_not_found' };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const actual = current;
  const expected = condition.value;
  const result = (matched: boolean, reason: ConditionEvaluation['reason'] = null): ConditionEvaluation => ({
    status: matched ? 'matched' : 'not_matched',
    actual,
    ...(reason ? { reason } : {}),
  });

  switch (condition.operator) {
    case 'exists':
      return result(true);
    case 'not_exists':
      return result(false);
    case 'equals':
      return result(Object.is(actual, expected));
    case 'not_equals':
      return result(!Object.is(actual, expected));
    case 'contains':
    case 'not_contains': {
      let contained: boolean | null = null;
      if (typeof actual === 'string' && typeof expected === 'string') contained = actual.includes(expected);
      else if (Array.isArray(actual)) contained = actual.some((item) => Object.is(item, expected));
      if (contained === null) return result(false, 'type_mismatch');
      return result(condition.operator === 'contains' ? contained : !contained);
    }
    case 'greater_than':
    case 'greater_than_or_equal':
    case 'less_than':
    case 'less_than_or_equal': {
      if (typeof actual !== 'number' || typeof expected !== 'number') return result(false, 'type_mismatch');
      const ops = {
        greater_than: actual > expected,
        greater_than_or_equal: actual >= expected,
        less_than: actual < expected,
        less_than_or_equal: actual <= expected,
      };
      return result(ops[condition.operator]);
    }
    case 'in':
    case 'not_in': {
      if (!Array.isArray(expected)) return result(false, 'type_mismatch');
      const member = expected.some((item) => Object.is(item, actual));
      return result(condition.operator === 'in' ? member : !member);
    }
    default:
      return { status: 'not_matched', reason: 'type_mismatch' };
  }
}

/**
 * 结构化输出：整段去空白后能 parse 就用；否则**恰好一个** ```json 代码块且能 parse；
 * 其余一律视为没有 outputJson（条件路径随之 path_not_found → 不放行）。
 */
export function parseStructuredOutput(output: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = output.trim();
  if (trimmed) {
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      // 落到代码块
    }
  }
  const fences = [...output.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/gi)];
  if (fences.length !== 1) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(fences[0][1].trim()) };
  } catch {
    return { ok: false };
  }
}

export function decideEdge(orchestration: EdgeOrchestration, outcome: SourceOutcome, context: DecisionContext): EdgeDecision {
  if (outcome === 'skipped') return { status: 'not_taken', reason: 'route_not_matched' };
  const routeMatched = orchestration.route === 'always' || orchestration.route === outcome;
  if (!routeMatched) return { status: 'not_taken', reason: 'route_not_matched' };
  if (!orchestration.condition) return { status: 'taken', reason: null };
  const evaluation = evaluateCondition(orchestration.condition, context);
  return evaluation.status === 'matched'
    ? { status: 'taken', reason: null, evaluation }
    : { status: 'not_taken', reason: 'condition_not_matched', evaluation };
}

export type JoinState = 'ready' | 'pending' | 'skipped';

export function decideJoin(mode: JoinMode, decisions: Array<EdgeDecision['status'] | undefined>): JoinState {
  if (decisions.length === 0) return 'ready';
  if (mode === 'all') {
    if (decisions.some((status) => status === 'not_taken')) return 'skipped';
    if (decisions.every((status) => status === 'taken')) return 'ready';
    return 'pending';
  }
  if (decisions.some((status) => status === 'taken')) return 'ready';
  if (decisions.every((status) => status !== undefined)) return 'skipped';
  return 'pending';
}

/** 边上的条件是否需要解析 outputJson（避免每个节点都 parse 一遍大输出）。 */
export function needsStructuredOutput(orchestrations: EdgeOrchestration[]): boolean {
  return orchestrations.some((item) => item.condition && (item.condition.path === 'outputJson' || item.condition.path.startsWith('outputJson.')));
}
