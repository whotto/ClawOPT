import { describe, expect, it } from 'vitest';
import { businessProjection, currentEpoch, edgePlayback, evidenceTabs, mergeEvidence, replayNodeStatus } from './evidence';
import { edgeLabel, makeEdge, staticBound, toSavePayload, validateForSave, wouldCloseForwardCycle } from './graph';
import { budgetToTimeoutMs, cronToFrequency, frequencyToCron } from './schedule-frequency';
import type { EdgeEvaluation, NodeExecution, RunEvidence, WfEdge, WfNode } from './types';

const node = (id: string, input = 'do it'): WfNode => ({
  id, type: 'agent', position: { x: 0, y: 0 },
  data: { title: id, agent: { kind: 'openclaw', id: 'main' }, input, skills: [], attachments: [], approvalRequired: false, orchestration: { join: 'all' } },
});
const edge = (source: string, target: string, orchestration: WfEdge['data']['orchestration'] = { route: 'success' }): WfEdge => ({ id: `${source}-${target}`, source, target, data: { orchestration } });

describe('graph validation mirrors the server', () => {
  it('accepts a valid loop graph', () => {
    expect(validateForSave([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a', { route: 'success', feedback: { maxIterations: 3 } })])).toBeNull();
  });
  it('reports the same reason codes as the compiler', () => {
    expect(validateForSave([], [])).toEqual({ reason: 'noNodes' });
    expect(validateForSave([node('a', '  ')], [])?.reason).toBe('inputRequired');
    expect(validateForSave([node('a'), node('b')], [])?.reason).toBe('orphanNode');
    expect(validateForSave([node('a'), node('b'), node('c'), node('d')], [edge('a', 'b'), edge('c', 'd')])?.reason).toBe('graphDisconnected');
    expect(validateForSave([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')])?.reason).toBe('forwardCycle');
    const multiEntry = [edge('s', 'h'), edge('h', 'm'), edge('s', 'm'), edge('m', 'l'), edge('l', 'h', { route: 'success', feedback: { maxIterations: 2 } })];
    expect(validateForSave(['s', 'h', 'm', 'l'].map((id) => node(id)), multiEntry)?.reason).toBe('loopNotSingleEntry');
    const overlap = [edge('a', 'b'), edge('b', 'c'), { ...edge('b', 'a', { route: 'success', feedback: { maxIterations: 2 } }) }, edge('c', 'b', { route: 'success', feedback: { maxIterations: 2 } })];
    expect(validateForSave(['a', 'b', 'c'].map((id) => node(id)), overlap)?.reason).toBe('loopPartialOverlap');
  });
  it('auto-marks cycle-closing edges as feedback', () => {
    const edges = [edge('a', 'b')];
    expect(wouldCloseForwardCycle(edges, 'b', 'a')).toBe(true);
    expect(makeEdge(edges, 'b', 'a').data.orchestration.feedback).toEqual({ maxIterations: 3 });
    expect(makeEdge(edges, 'a', 'c').data.orchestration.feedback).toBeUndefined();
    expect(makeEdge(edges, 'a', 'b').id).toBe('a-b-2');
  });
  it('strips canvas-only keys when saving', () => {
    const decorated = { ...node('a'), selected: true, measured: { width: 1 } } as unknown as WfNode;
    expect(Object.keys(toSavePayload([decorated], []).nodes[0]).sort()).toEqual(['data', 'id', 'position', 'type']);
  });
  it('labels and static bound', () => {
    expect(edgeLabel({ route: 'failure', condition: { path: 'outputJson.decision', operator: 'equals', value: 'PASS' } })).toBe('failure · outputJson.decision equals "PASS"');
    expect(staticBound([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'b', { route: 'success', feedback: { maxIterations: 4 } })])).toBe(9);
  });
});

const exec = (id: string, nodeId: string, status: NodeExecution['status'], sequence: number, extra: Partial<NodeExecution> = {}): NodeExecution => ({
  id, nodeId, executionId: nodeId, iterationPath: { scope: null, steps: [] }, consumedEdgeEvaluationIds: [], sessionId: null, status, error: null,
  sequence, updatedSeq: sequence, remainingTimeoutMsAtStart: null, startedAt: 10, finishedAt: null, createdAt: 10, ...extra,
});
const evaluation = (id: string, edgeId: string, target: string, status: 'taken' | 'not_taken', sequence: number, extra: Partial<EdgeEvaluation> = {}): EdgeEvaluation => ({
  id, edgeId, sourceNodeId: 'a', targetNodeId: target, sourceExecutionId: 'a', iterationPath: { scope: null, steps: [] }, sourceOutcome: 'success', status,
  route: 'success', reason: status === 'taken' ? null : 'condition_not_matched', orchestration: { route: 'success' }, conditionEvaluation: null, sequence, evaluatedAt: 10, ...extra,
});

describe('evidence', () => {
  it('merges deltas: executions overwrite by id, evaluations append once', () => {
    const base: RunEvidence = { nodeExecutions: [exec('e1', 'a', 'running', 1)], edgeEvaluations: [], loopEpochs: [] };
    const merged = mergeEvidence(base, { nodeExecutions: [exec('e1', 'a', 'completed', 1, { updatedSeq: 3 })], edgeEvaluations: [evaluation('v1', 'a-b', 'b', 'taken', 2)], loopEpochs: [] });
    expect(merged.nodeExecutions).toHaveLength(1);
    expect(merged.nodeExecutions[0].status).toBe('completed');
    expect(mergeEvidence(merged, { nodeExecutions: [], edgeEvaluations: [evaluation('v1', 'a-b', 'b', 'taken', 2)], loopEpochs: [] }).edgeEvaluations).toHaveLength(1);
  });
  it('filters to the latest epoch after a rerun', () => {
    const evidence: RunEvidence = { nodeExecutions: [exec('old', 'a', 'completed', 1, { createdAt: 5 }), exec('new', 'a', 'running', 5, { createdAt: 20 })], edgeEvaluations: [], loopEpochs: [] };
    expect(currentEpoch({ startedAt: 15 }, evidence).nodeExecutions.map((row) => row.id)).toEqual(['new']);
    const withBoundary: RunEvidence = {
      nodeExecutions: [exec('new', 'b', 'completed', 5, { createdAt: 20, consumedEdgeEvaluationIds: ['kept'] })],
      edgeEvaluations: [evaluation('kept', 'a-b', 'b', 'taken', 2, { evaluatedAt: 5 }), evaluation('stale', 'a-c', 'c', 'taken', 3, { evaluatedAt: 5 })],
      loopEpochs: [],
    };
    expect(currentEpoch({ startedAt: 15 }, withBoundary).edgeEvaluations.map((row) => row.id)).toEqual(['kept']);
  });
  it('derives replay statuses including skipped', () => {
    const evidence: RunEvidence = { nodeExecutions: [exec('e1', 'a', 'completed', 1)], edgeEvaluations: [evaluation('v1', 'a-b', 'b', 'not_taken', 2)], loopEpochs: [] };
    const run = { status: 'completed' as const };
    expect(replayNodeStatus('a', run, evidence, null)).toBe('completed');
    expect(replayNodeStatus('b', run, evidence, null)).toBe('skipped');
    expect(replayNodeStatus('c', run, evidence, null)).toBe('idle');
    expect(replayNodeStatus('c', { status: 'running' }, evidence, { c: 'pending_approval' })).toBe('pending_approval');
  });
  it('splits tabs into actual path / other judgments / loops', () => {
    const evidence: RunEvidence = {
      nodeExecutions: [exec('e2', 'b', 'completed', 4, { consumedEdgeEvaluationIds: ['v1'] }), exec('e3', 'c', 'failed', 5)],
      edgeEvaluations: [evaluation('v1', 'a-b', 'b', 'taken', 2), evaluation('v2', 'a-x', 'x', 'not_taken', 3)],
      loopEpochs: [{ id: 'l1', loopId: 'loop', iteration: 0, iterationPath: { scope: null, steps: [] }, status: 'completed', exitReason: 'feedback_taken', sequence: 6, startedAt: 10, finishedAt: 11 }],
    };
    const tabs = evidenceTabs(evidence);
    expect(tabs.actual.map((row) => row.kind === 'edge' && row.row.id)).toEqual(['v1']);
    expect(tabs.other.map((row) => row.kind)).toEqual(['edge', 'node', 'loop']);
    expect(tabs.loops).toHaveLength(1);
  });
  it('edge playback states', () => {
    const run = { status: 'running' as const };
    const e = edge('a', 'b');
    const taken: RunEvidence = { nodeExecutions: [], edgeEvaluations: [evaluation('v1', 'a-b', 'b', 'taken', 1)], loopEpochs: [] };
    expect(edgePlayback(e, run, taken, 'running')).toBe('flowing');
    expect(edgePlayback(e, { status: 'completed' }, taken, 'completed')).toBe('completed');
    expect(edgePlayback(e, run, { ...taken, edgeEvaluations: [evaluation('v1', 'a-b', 'b', 'not_taken', 1)] }, 'skipped')).toBe('inactive');
    expect(edgePlayback(e, run, { nodeExecutions: [], edgeEvaluations: [], loopEpochs: [] }, 'idle')).toBe('idle');
  });
  it('business projection surfaces decision fields', () => {
    expect(businessProjection('{"decision":"BLOCKED","failed_gate":"tests","blocking_reasons":["a","b"]}')).toEqual({ decision: 'BLOCKED', gate: 'tests', reason: 'a; b' });
    expect(businessProjection('plain')).toBeNull();
  });
});

describe('schedule frequency', () => {
  it('round-trips presets', () => {
    for (const cron of ['* * * * *', '*/5 * * * *', '*/30 * * * *', '15 * * * *', '30 9 * * *', '0 9 * * 1', '0 8 15 * *']) {
      expect(frequencyToCron(cronToFrequency(cron))).toBe(cron);
    }
    expect(cronToFrequency('0 9 * JAN MON')).toEqual({ kind: 'custom', cron: '0 9 * JAN MON' });
  });
  it('budget minutes to timeout', () => {
    expect(budgetToTimeoutMs(null)).toBeNull();
    expect(budgetToTimeoutMs(30)).toBe(1_800_000);
    expect(() => budgetToTimeoutMs(0.01)).toThrow();
    expect(() => budgetToTimeoutMs(2000)).toThrow();
  });
});
