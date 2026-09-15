import { useCallback, useEffect, useState } from 'react';
import { batchDeleteWorkflows, createWorkflow, deleteWorkflow, listWorkflowAgents, listWorkflows } from '../../../api/automation';
import { requestJson, type ApiError } from '../lib/request';
import type { AgentEntry, WorkflowDefinition, WorkflowSummary } from '../lib/types';

/** 工作流列表 + 节点可选的 Agent 名册。 */
export function useWorkflowList() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [fakeRunner, setFakeRunner] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(async () => {
    const result = await requestJson<{ workflows: WorkflowSummary[] }>(listWorkflows());
    if (result.ok) setWorkflows(result.data.workflows);
    else setError(result.error);
    setLoaded(true);
  }, []);

  const reloadAgents = useCallback(async () => {
    const result = await requestJson<{ agents: AgentEntry[]; fakeRunner: boolean }>(listWorkflowAgents());
    if (result.ok) {
      setAgents(result.data.agents);
      setFakeRunner(result.data.fakeRunner);
    }
  }, []);

  useEffect(() => {
    void reload();
    void reloadAgents();
  }, [reload, reloadAgents]);

  const create = useCallback(async (name: string) => {
    const result = await requestJson<{ workflow: WorkflowDefinition }>(createWorkflow({ name }));
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    await reload();
    return result.data.workflow;
  }, [reload]);

  const remove = useCallback(async (ids: string[]) => {
    const result = ids.length === 1
      ? await requestJson<unknown>(deleteWorkflow(ids[0]))
      : await requestJson<unknown>(batchDeleteWorkflows(ids));
    if (!result.ok) setError(result.error);
    await reload();
    return result.ok;
  }, [reload]);

  return { workflows, loaded, agents, fakeRunner, error, setError, reload, reloadAgents, create, remove };
}

export type WorkflowListController = ReturnType<typeof useWorkflowList>;
