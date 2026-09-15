import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteWorkflowRun,
  getNodeTranscript,
  getWorkflowRun,
  listWorkflowRuns,
  openWorkflowEvents,
  rerunFromNode,
  resolveNodeApproval,
  runWorkflow,
  stopWorkflowRun,
} from '../../../api/automation';
import { emptyEvidence, isRunLive, maxSeq, mergeEvidence } from '../lib/evidence';
import { requestJson, type ApiError } from '../lib/request';
import type { RunEvidence, RunRecord, RuntimeStatus, Transcript } from '../lib/types';

type HubStatus = { type: 'status'; status: RuntimeStatus };
type HubEvidence = { type: 'evidence'; runId: string; sinceSeq: number; seq: number; evidence: RunEvidence };

/**
 * 运行历史、选中运行的快照与证据、实时状态流（SSE，增量合并）、以及运行相关动作。
 * 自动跟随：用户刚启动的运行在活着期间自动选中，除非用户手动取消选中（按运行 id 记住）。
 */
export function useWorkflowRuns(workflowId: string | null) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [evidence, setEvidence] = useState<RunEvidence>(emptyEvidence);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const optedOut = useRef(new Set<string>());
  const autoFollow = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const evidenceRef = useRef<RunEvidence>(emptyEvidence());
  selectedRef.current = selectedRunId;
  evidenceRef.current = evidence;

  const reloadRuns = useCallback(async () => {
    if (!workflowId) return;
    const result = await requestJson<{ runs: RunRecord[] }>(listWorkflowRuns(workflowId));
    if (result.ok) setRuns(result.data.runs);
  }, [workflowId]);

  const loadRun = useCallback(async (runId: string) => {
    if (!workflowId) return;
    const result = await requestJson<{ run: RunRecord; evidence: RunEvidence }>(getWorkflowRun(workflowId, runId));
    if (!result.ok || selectedRef.current !== runId) return;
    setSelectedRun(result.data.run);
    setEvidence(result.data.evidence);
  }, [workflowId]);

  useEffect(() => {
    setRuns([]);
    setSelectedRunId(null);
    setSelectedRun(null);
    setEvidence(emptyEvidence());
    setRuntime(null);
    void reloadRuns();
  }, [workflowId, reloadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      setEvidence(emptyEvidence());
      return;
    }
    void loadRun(selectedRunId);
  }, [selectedRunId, loadRun]);

  // 状态流：话题 workflow:<id>。选中运行时带上已有序号，断线重连只补增量。
  useEffect(() => {
    if (!workflowId) return;
    const since = selectedRef.current ? { runId: selectedRef.current, seq: maxSeq(evidenceRef.current) } : undefined;
    const source = openWorkflowEvents(workflowId, since);
    const onStatus = (event: MessageEvent) => {
      const message = JSON.parse(event.data) as HubStatus;
      const status = message.status;
      setRuntime(status);
      setRuns((current) => {
        if (!status.runId) return current;
        if (!current.some((run) => run.id === status.runId)) {
          void reloadRuns();
          return current;
        }
        return current.map((run) => (run.id === status.runId ? { ...run, status: status.status as RunRecord['status'], error: status.error, errorCode: status.errorCode, finishedAt: status.finishedAt, startedAt: status.startedAt ?? run.startedAt } : run));
      });
      if (status.runId && status.runId === selectedRef.current) {
        setSelectedRun((current) => (current ? { ...current, status: status.status as RunRecord['status'], error: status.error, errorCode: status.errorCode, finishedAt: status.finishedAt, startedAt: status.startedAt ?? current.startedAt } : current));
      }
      if (status.runId && isRunLive(status.status) && !optedOut.current.has(status.runId) && selectedRef.current !== status.runId && autoFollow.current === status.runId) {
        setSelectedRunId(status.runId);
      }
    };
    const onEvidence = (event: MessageEvent) => {
      const message = JSON.parse(event.data) as HubEvidence;
      if (message.runId !== selectedRef.current) return;
      setEvidence((current) => mergeEvidence(current, message.evidence));
    };
    source.addEventListener('status', onStatus);
    source.addEventListener('evidence', onEvidence);
    return () => source.close();
    // 选中运行变化不重连：增量里带 runId，按当前选中过滤即可
  }, [workflowId, reloadRuns]);

  const selectRun = useCallback((runId: string | null) => {
    if (!runId && selectedRef.current) optedOut.current.add(selectedRef.current);
    setSelectedRunId(runId);
  }, []);

  const start = useCallback(async (body: { input?: string; timeout_ms?: number | null }) => {
    if (!workflowId) return false;
    setBusy(true);
    const result = await requestJson<{ run: RunRecord }>(runWorkflow(workflowId, body));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    autoFollow.current = result.data.run.id;
    await reloadRuns();
    setSelectedRunId(result.data.run.id);
    return true;
  }, [workflowId, reloadRuns]);

  const stop = useCallback(async (runId: string) => {
    if (!workflowId) return;
    const result = await requestJson<unknown>(stopWorkflowRun(workflowId, runId));
    if (!result.ok) setError(result.error);
    await reloadRuns();
    if (selectedRef.current === runId) void loadRun(runId);
  }, [workflowId, reloadRuns, loadRun]);

  const removeRun = useCallback(async (runId: string) => {
    if (!workflowId) return;
    const result = await requestJson<unknown>(deleteWorkflowRun(workflowId, runId));
    if (!result.ok) setError(result.error);
    if (selectedRef.current === runId) setSelectedRunId(null);
    await reloadRuns();
  }, [workflowId, reloadRuns]);

  const approve = useCallback(async (runId: string, nodeId: string, executionId: string, approved: boolean) => {
    if (!workflowId) return false;
    const result = await requestJson<unknown>(resolveNodeApproval(workflowId, runId, nodeId, approved, executionId));
    if (!result.ok) setError(result.error);
    return result.ok;
  }, [workflowId]);

  const rerun = useCallback(async (runId: string, nodeId: string, preserve: boolean, timeoutMs: number | null) => {
    if (!workflowId) return false;
    setBusy(true);
    const result = await requestJson<{ run: RunRecord }>(rerunFromNode(workflowId, runId, { node_id: nodeId, preserve_start_node: preserve, timeout_ms: timeoutMs }));
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    autoFollow.current = runId;
    optedOut.current.delete(runId);
    await reloadRuns();
    void loadRun(runId);
    return true;
  }, [workflowId, reloadRuns, loadRun]);

  const transcript = useCallback(async (runId: string, executionId: string): Promise<Transcript | null> => {
    if (!workflowId) return null;
    const result = await requestJson<{ transcript: Transcript }>(getNodeTranscript(workflowId, runId, executionId));
    return result.ok ? result.data.transcript : null;
  }, [workflowId]);

  return {
    runs, selectedRunId, selectedRun, evidence, runtime, error, setError, busy,
    selectRun, start, stop, removeRun, approve, rerun, transcript, reloadRuns,
  };
}

export type WorkflowRunsController = ReturnType<typeof useWorkflowRuns>;
