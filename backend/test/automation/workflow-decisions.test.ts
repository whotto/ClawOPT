/**
 * 判定：路由匹配、强类型条件、结构化输出解析、汇合表。
 */
import { describe, expect, it } from 'vitest';

import { decideEdge, decideJoin, evaluateCondition, parseStructuredOutput } from '../../src/automation/workflow/decisions';

const cond = (path: string, operator: any, value?: unknown) => ({ path, operator, ...(value === undefined ? {} : { value }) });

describe('条件运算符（无隐式转换）', () => {
  const ctx = { output: 'hello world', outputJson: { score: 5, tags: ['a', 'b'], decision: 'PASS', nested: { ok: true }, nan: Number.NaN, zero: 0 } };

  it.each([
    ['equals 同类型同值', cond('outputJson.decision', 'equals', 'PASS'), 'matched'],
    ['equals 不做字符串转数字', cond('outputJson.score', 'equals', '5'), 'not_matched'],
    ['not_equals 类型不同为真', cond('outputJson.score', 'not_equals', '5'), 'matched'],
    ['equals NaN 等于 NaN', cond('outputJson.nan', 'equals', Number.NaN), 'matched'],
    ['equals +0 不等于 -0', cond('outputJson.zero', 'equals', -0), 'not_matched'],
    ['contains 子串', cond('output', 'contains', 'world'), 'matched'],
    ['not_contains 子串不在', cond('output', 'not_contains', 'mars'), 'matched'],
    ['contains 数组按元素', cond('outputJson.tags', 'contains', 'a'), 'matched'],
    ['contains 数组不做子串', cond('outputJson.tags', 'contains', 'ab'), 'not_matched'],
    ['contains 对数字：假', cond('outputJson.score', 'contains', 5), 'not_matched'],
    ['not_contains 对数字：同样为假（不是取反）', cond('outputJson.score', 'not_contains', 5), 'not_matched'],
    ['contains 对对象：假', cond('outputJson.nested', 'contains', 'ok'), 'not_matched'],
    ['greater_than 数字', cond('outputJson.score', 'greater_than', 4), 'matched'],
    ['greater_than 字符串值：假', cond('outputJson.score', 'greater_than', '4'), 'not_matched'],
    ['less_than_or_equal 边界', cond('outputJson.score', 'less_than_or_equal', 5), 'matched'],
    ['greater_than_or_equal 实际值不是数字：假', cond('outputJson.decision', 'greater_than_or_equal', 1), 'not_matched'],
    ['in 数组成员', cond('outputJson.decision', 'in', ['PASS', 'OK']), 'matched'],
    ['in 值不是数组：假', cond('outputJson.decision', 'in', 'PASS'), 'not_matched'],
    ['not_in 值不是数组：同样为假', cond('outputJson.decision', 'not_in', 'FAIL'), 'not_matched'],
    ['not_in 不在', cond('outputJson.decision', 'not_in', ['FAIL']), 'matched'],
    ['exists 存在', cond('outputJson.nested.ok', 'exists'), 'matched'],
    ['exists 不存在', cond('outputJson.missing', 'exists'), 'not_matched'],
    ['not_exists 不存在', cond('outputJson.missing', 'not_exists'), 'matched'],
    ['not_exists 存在', cond('output', 'not_exists'), 'not_matched'],
    ['路径穿过非对象', cond('output.length', 'equals', 11), 'not_matched'],
  ])('%s', (_label, condition, expected) => {
    expect(evaluateCondition(condition as any, ctx).status).toBe(expected);
  });

  it('只走自有属性：原型链上的属性视为不存在', () => {
    expect(evaluateCondition(cond('outputJson.toString', 'exists') as any, { outputJson: {} }).status).toBe('not_matched');
  });

  it('禁止段即使绕过规范化也不会被读取', () => {
    expect(evaluateCondition(cond('outputJson.__proto__', 'exists') as any, { outputJson: {} })).toMatchObject({ status: 'not_matched', reason: 'path_not_found' });
  });

  it('结果带 actual 供证据回放', () => {
    expect(evaluateCondition(cond('outputJson.score', 'greater_than', 9) as any, ctx)).toEqual({ status: 'not_matched', actual: 5 });
  });
});

describe('结构化输出', () => {
  it('整段 JSON', () => {
    expect(parseStructuredOutput(' {"a":1} ')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('恰好一个 json 代码块', () => {
    expect(parseStructuredOutput('结论如下\n```json\n{"decision":"BLOCKED"}\n```\n')).toEqual({ ok: true, value: { decision: 'BLOCKED' } });
  });
  it('两个代码块 → 无结构化输出（不猜）', () => {
    expect(parseStructuredOutput('```json\n{"a":1}\n```\n```json\n{"a":2}\n```')).toEqual({ ok: false });
  });
  it('代码块内容坏 JSON → 无', () => {
    expect(parseStructuredOutput('```json\n{a:1}\n```')).toEqual({ ok: false });
  });
});

describe('边判定', () => {
  it('路由不匹配 → route_not_matched', () => {
    expect(decideEdge({ route: 'failure' }, 'success', { output: 'x' })).toEqual({ status: 'not_taken', reason: 'route_not_matched' });
  });
  it('always 对成功与失败都匹配', () => {
    expect(decideEdge({ route: 'always' }, 'failure', { error: 'e' }).status).toBe('taken');
    expect(decideEdge({ route: 'always' }, 'success', { output: 'x' }).status).toBe('taken');
  });
  it('上游被跳过 → 一律 not_taken', () => {
    expect(decideEdge({ route: 'always' }, 'skipped', {})).toEqual({ status: 'not_taken', reason: 'route_not_matched' });
  });
  it('条件不满足 → condition_not_matched 并带评估', () => {
    const decision = decideEdge({ route: 'success', condition: cond('output', 'contains', 'yes') as any }, 'success', { output: 'no' });
    expect(decision).toMatchObject({ status: 'not_taken', reason: 'condition_not_matched', evaluation: { status: 'not_matched', actual: 'no' } });
  });
  it('outputJson 缺失时条件 fail closed', () => {
    expect(decideEdge({ route: 'success', condition: cond('outputJson.decision', 'equals', 'PASS') as any }, 'success', { output: 'PASS' }).status).toBe('not_taken');
  });
});

describe('汇合表', () => {
  it.each([
    ['all', [], 'ready'],
    ['all', ['taken', 'taken'], 'ready'],
    ['all', ['taken', undefined], 'pending'],
    ['all', ['taken', 'not_taken'], 'skipped'],
    ['all', [undefined, 'not_taken'], 'skipped'],
    ['any', ['taken', undefined], 'ready'],
    ['any', ['not_taken', undefined], 'pending'],
    ['any', ['not_taken', 'not_taken'], 'skipped'],
    ['any', [], 'ready'],
  ])('%s %j → %s', (mode, decisions, expected) => {
    expect(decideJoin(mode as any, decisions as any)).toBe(expected);
  });
});
