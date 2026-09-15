// 工作流页：左侧列表、中间画布（编辑 / 回放）、右侧运行面板、节点转录侧栏，以及定时 / 钩子 / 导入导出 / 设置弹窗。
// 状态都在 features/workflow/hooks 里；这里只做编排与模式切换。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import EdgeEditorDrawer from '../../../features/workflow/components/EdgeEditorDrawer';
import HooksModal from '../../../features/workflow/components/HooksModal';
import ImportExportModal from '../../../features/workflow/components/ImportExportModal';
import RunBudgetModal from '../../../features/workflow/components/RunBudgetModal';
import RunPanel from '../../../features/workflow/components/RunPanel';
import SchedulesModal from '../../../features/workflow/components/SchedulesModal';
import TranscriptPanel from '../../../features/workflow/components/TranscriptPanel';
import { ErrorBanner, InfoBanner } from '../../../features/workflow/components/ui';
import WorkflowCanvas, { type ContextMenuAction } from '../../../features/workflow/components/WorkflowCanvas';
import WorkflowListPanel from '../../../features/workflow/components/WorkflowListPanel';
import WorkflowSettingsModal, { useConcurrencyInfo } from '../../../features/workflow/components/WorkflowSettingsModal';
import WorkflowToolbar, { type ToolbarModal } from '../../../features/workflow/components/WorkflowToolbar';
import { fromCanvasEdge, fromCanvasNode, toCanvasEdge, toCanvasNode, useWorkflowEditor } from '../../../features/workflow/hooks/useWorkflowEditor';
import { useWorkflowList } from '../../../features/workflow/hooks/useWorkflowList';
import { useWorkflowRuns } from '../../../features/workflow/hooks/useWorkflowRuns';
import { currentEpoch, edgePlayback, isRunLive, replayNodeStatus } from '../../../features/workflow/lib/evidence';
import { staticBound } from '../../../features/workflow/lib/graph';
import { describeError } from '../../../features/workflow/lib/request';
import type { AgentRef } from '../../../features/workflow/lib/types';

type BudgetRequest = { kind: 'run' } | { kind: 'rerun'; nodeId: string; preserve: boolean };

export default function WorkflowsPage({ workflowId, onSelectWorkflow }: { workflowId: string | null; onSelectWorkflow: (id: string | null) => void }) {
  const { t } = useTranslation();
  const list = useWorkflowList();
  const editor = useWorkflowEditor(workflowId, list.reload);
  const runs = useWorkflowRuns(workflowId);
  const concurrency = useConcurrencyInfo();
  const [modal, setModal] = useState<ToolbarModal | null>(null);
  const [budget, setBudget] = useState<BudgetRequest | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const [transcriptNode, setTranscriptNode] = useState<{ nodeId: string; executionId: string | null } | null>(null);

  // 地址栏里的工作流不存在（被删了）→ 清掉；没选时自动选第一个（不进历史由壳层处理）。
  useEffect(() => {
    if (!list.loaded) return;
    if (workflowId && !list.workflows.some((item) => item.id === workflowId)) onSelectWorkflow(list.workflows[0]?.id ?? null);
    else if (!workflowId && list.workflows.length) onSelectWorkflow(list.workflows[0].id);
  }, [list.loaded, list.workflows, workflowId, onSelectWorkflow]);

  const replay = Boolean(runs.selectedRun);
  const run = runs.selectedRun;
  const epoch = useMemo(() => (run ? currentEpoch(run, runs.evidence) : runs.evidence), [run, runs.evidence]);
  const liveStatuses = runs.runtime && run && runs.runtime.runId === run.id ? runs.runtime.nodeStatuses : null;

  const canvasNodes = useMemo(() => {
    if (!run?.snapshotNodes) return editor.nodes;
    // 回放用冻结快照；快照里没有位置的节点退回当前画布上的位置。
    return run.snapshotNodes.map((node) => {
      const current = editor.nodes.find((item) => item.id === node.id);
      return toCanvasNode({ ...node, position: node.position ?? current?.position ?? { x: 0, y: 0 } });
    });
  }, [run, editor.nodes]);
  const canvasEdges = useMemo(() => (run?.snapshotEdges ? run.snapshotEdges.map(toCanvasEdge) : editor.edges), [run, editor.edges]);

  const statusOf = useCallback((nodeId: string) => {
    if (!run) return null;
    const status = replayNodeStatus(nodeId, run, epoch, liveStatuses);
    // 重跑时保留的上游在本轮没有执行：显示它上一轮的结局，而不是「未运行」。
    return status === 'idle' ? replayNodeStatus(nodeId, run, runs.evidence, null) : status;
  }, [run, epoch, liveStatuses, runs.evidence]);
  const errorOf = useCallback((nodeId: string) => {
    if (!run) return null;
    const rows = epoch.nodeExecutions.filter((row) => row.nodeId === nodeId);
    return rows[rows.length - 1]?.error ?? null;
  }, [run, epoch]);
  const edgeStateOf = useCallback((edgeId: string) => {
    if (!run) return null;
    const edge = canvasEdges.find((item) => item.id === edgeId);
    return edge ? edgePlayback(fromCanvasEdge(edge), run, epoch, statusOf(edge.target) ?? 'idle') : null;
  }, [run, canvasEdges, epoch, statusOf]);

  const defaultAgent: AgentRef | null = list.agents.find((entry) => entry.available)?.ref ?? null;
  const addNodeAtOrigin = () => {
    if (!defaultAgent) return;
    const offset = editor.nodes.length * 24;
    editor.addNode(defaultAgent, { x: 80 + offset, y: 80 + offset });
  };

  const nodeMenu = (nodeId: string): ContextMenuAction[] => {
    if (!replay || !run) {
      return [{ key: 'delete', label: t('common.delete'), danger: true, onSelect: () => editor.removeElements([nodeId], []) }];
    }
    const live = isRunLive(run.status);
    const executions = epoch.nodeExecutions.filter((row) => row.nodeId === nodeId);
    const latest = executions[executions.length - 1];
    const hasDownstream = canvasEdges.some((edge) => edge.source === nodeId && !edge.data?.orchestration.feedback);
    return [
      { key: 'transcript', label: t('automation.canvas.openTranscript'), disabled: !latest, onSelect: () => setTranscriptNode({ nodeId, executionId: latest?.executionId ?? null }) },
      { key: 'keep', label: t('automation.canvas.rerunKeep'), disabled: live || runs.busy || !latest || latest.status !== 'completed' || !hasDownstream, onSelect: () => setBudget({ kind: 'rerun', nodeId, preserve: true }) },
      { key: 'clear', label: t('automation.canvas.rerunClear'), disabled: live || runs.busy, onSelect: () => setBudget({ kind: 'rerun', nodeId, preserve: false }) },
    ];
  };
  const edgeMenu = (edgeId: string): ContextMenuAction[] => [
    { key: 'edit', label: t('common.edit'), onSelect: () => setEditingEdgeId(edgeId) },
    { key: 'delete', label: t('common.delete'), danger: true, onSelect: () => editor.removeElements([], [edgeId]) },
  ];

  const editingEdge = editingEdgeId ? editor.edges.find((edge) => edge.id === editingEdgeId) : null;
  const errors = [list.error, editor.error, runs.error].filter(Boolean);
  const transcriptExecutions = transcriptNode ? epoch.nodeExecutions.filter((row) => row.nodeId === transcriptNode.nodeId) : [];
  const loopTitle = (loopId: string) => {
    const loop = run?.compiledLoops.find((item) => item.id === loopId);
    return canvasNodes.find((node) => node.id === loop?.headerNodeId)?.data.title ?? loopId;
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="hidden md:flex w-60 shrink-0 border-r border-gray-200 bg-white">
        <WorkflowListPanel
          workflows={list.workflows}
          activeId={workflowId}
          onSelect={(id) => { runs.selectRun(null); onSelectWorkflow(id); }}
          onCreate={async (name) => { const created = await list.create(name); if (created) onSelectWorkflow(created.id); }}
          onDelete={async (ids) => { await list.remove(ids); if (workflowId && ids.includes(workflowId)) onSelectWorkflow(null); }}
        />
      </div>
      <div className="flex-1 min-w-0 flex flex-col relative">
        <div className="md:hidden px-3 py-2 border-b border-gray-200 bg-white">
          <select className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 bg-gray-50" value={workflowId ?? ''} onChange={(event) => onSelectWorkflow(event.target.value || null)}>
            {!list.workflows.length && <option value="">{t('automation.list.empty')}</option>}
            {list.workflows.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        {workflowId && editor.definition ? (
          <>
            <WorkflowToolbar
              name={editor.name}
              onName={editor.setName}
              replay={replay}
              dirty={editor.dirty}
              saving={editor.saving}
              canUndo={editor.canUndo}
              runBusy={runs.busy}
              savedAt={editor.savedAt}
              onAddNode={addNodeAtOrigin}
              onUndo={editor.undo}
              onSave={() => void editor.save()}
              onRun={() => setBudget({ kind: 'run' })}
              onModal={setModal}
              runsOpen={runsOpen}
              onToggleRuns={() => setRunsOpen(!runsOpen)}
              onExitReplay={() => runs.selectRun(null)}
            />
            <div className="px-3 pt-2 space-y-2 empty:hidden">
              {errors.map((error, index) => <ErrorBanner key={index} message={describeError(t, error!)} detail={error!.detail} onDismiss={() => { list.setError(null); editor.setError(null); runs.setError(null); }} />)}
              {editor.issue && <ErrorBanner message={t(`automation.graph.${editor.issue.reason}`, editor.issue.params ?? {})} onDismiss={() => editor.setIssue(null)} />}
              {list.fakeRunner && <InfoBanner>{t('automation.canvas.fakeRunner')}</InfoBanner>}
              {replay && run && <InfoBanner>{t('automation.canvas.replayBanner')}</InfoBanner>}
            </div>
            <div className="flex-1 min-h-0 flex relative">
              <div className="flex-1 min-w-0 relative">
                <WorkflowCanvas
                  fitKey={`${workflowId}:${run?.id ?? 'edit'}`}
                  nodes={canvasNodes}
                  edges={canvasEdges}
                  context={{
                    mode: replay ? 'replay' : 'edit',
                    agents: list.agents,
                    statusOf,
                    errorOf,
                    onChange: editor.updateNodeData,
                    onOpenNode: (nodeId) => {
                      if (!replay) return;
                      const rows = epoch.nodeExecutions.filter((row) => row.nodeId === nodeId);
                      setTranscriptNode({ nodeId, executionId: rows[rows.length - 1]?.executionId ?? null });
                    },
                    edgeStateOf,
                  }}
                  defaultAgent={defaultAgent}
                  initialViewport={replay ? null : editor.initialViewport()}
                  onNodesChange={editor.onNodesChange}
                  onEdgesChange={editor.onEdgesChange}
                  onConnect={editor.connect}
                  onCreateFromHandle={editor.addNode}
                  onEditEdge={setEditingEdgeId}
                  onViewportChange={editor.setViewport}
                  onUndo={editor.undo}
                  nodeMenu={nodeMenu}
                  edgeMenu={edgeMenu}
                />
                {!editor.nodes.length && !replay && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <p className="text-sm text-gray-400">{defaultAgent ? t('automation.canvas.emptyHint') : t('automation.canvas.noAgents')}</p>
                  </div>
                )}
                {transcriptNode && run && (
                  <TranscriptPanel
                    key={`${run.id}:${transcriptNode.nodeId}`}
                    run={run}
                    nodeTitle={canvasNodes.find((node) => node.id === transcriptNode.nodeId)?.data.title ?? transcriptNode.nodeId}
                    executions={transcriptExecutions}
                    initialExecutionId={transcriptNode.executionId}
                    loadTranscript={runs.transcript}
                    onApprove={(executionId, approved) => runs.approve(run.id, transcriptNode.nodeId, executionId, approved)}
                    onClose={() => setTranscriptNode(null)}
                    loopTitle={loopTitle}
                  />
                )}
              </div>
              {(runsOpen || replay) && (
                <div className="absolute md:static inset-y-0 right-0 z-20 w-[85vw] md:w-80 shrink-0 border-l border-gray-200 bg-white">
                  <RunPanel
                    runs={runs.runs}
                    selectedRun={run}
                    evidence={runs.evidence}
                    nodes={canvasNodes.map(fromCanvasNode)}
                    edges={canvasEdges.map(fromCanvasEdge)}
                    onSelect={(id) => { runs.selectRun(id); if (!id) setTranscriptNode(null); }}
                    onStop={(id) => void runs.stop(id)}
                    onDelete={(id) => void runs.removeRun(id)}
                    onOpenExecution={(nodeId, executionId) => setTranscriptNode({ nodeId, executionId })}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-sm text-gray-500">{list.loaded ? t('automation.canvas.pickWorkflow') : t('automation.common.loading')}</p>
          </div>
        )}
      </div>

      {editingEdge && (
        <EdgeEditorDrawer
          edge={fromCanvasEdge(editingEdge)}
          nodes={editor.nodes.map(fromCanvasNode)}
          edges={editor.edges.map(fromCanvasEdge)}
          describeIssue={(issue) => t(`automation.graph.${issue.reason}`, issue.params ?? {})}
          onSave={(orchestration) => { editor.updateEdge(editingEdge.id, orchestration); setEditingEdgeId(null); }}
          onClose={() => setEditingEdgeId(null)}
        />
      )}
      {budget && (
        <RunBudgetModal
          title={budget.kind === 'run' ? t('automation.budget.runTitle') : t(budget.preserve ? 'automation.canvas.rerunKeep' : 'automation.canvas.rerunClear')}
          showInput={budget.kind === 'run'}
          staticBound={budget.kind === 'run' ? staticBound(editor.nodes.map(fromCanvasNode), editor.edges.map(fromCanvasEdge)) : null}
          concurrency={concurrency.info?.concurrency ?? null}
          busy={runs.busy}
          onClose={() => setBudget(null)}
          onSubmit={async ({ timeoutMs, input }) => {
            const ok = budget.kind === 'run'
              ? await runs.start({ timeout_ms: timeoutMs, ...(input.trim() ? { input } : {}) })
              : run ? await runs.rerun(run.id, budget.nodeId, budget.preserve, timeoutMs) : false;
            if (ok) {
              setBudget(null);
              setRunsOpen(true);
            }
          }}
        />
      )}
      {modal === 'schedules' && workflowId && editor.definition && <SchedulesModal workflowId={workflowId} savedNodes={editor.definition.nodes} onClose={() => setModal(null)} />}
      {modal === 'hooks' && workflowId && editor.definition && <HooksModal workflowId={workflowId} savedNodes={editor.definition.nodes} onClose={() => setModal(null)} />}
      {modal === 'io' && (
        <ImportExportModal
          workflow={editor.definition ? { id: editor.definition.id, name: editor.definition.name } : null}
          onImported={async (created) => { await list.reload(); onSelectWorkflow(created.id); }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'settings' && <WorkflowSettingsModal info={concurrency.info} onSaved={() => void concurrency.reload()} onClose={() => setModal(null)} />}
    </div>
  );
}
