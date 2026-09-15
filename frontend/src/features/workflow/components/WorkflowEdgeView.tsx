// 连线：贝塞尔曲线 + 标签；自环画成节点外侧 80px 的直角路径，标签放在外角。回放时按证据着色。
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CanvasEdge } from '../hooks/useWorkflowEditor';
import { edgeLabel } from '../lib/graph';
import { useCanvasContext } from './canvasContext';

// 颜色取设计 token（Tailwind v4 的 CSS 变量），跟全局配色一起变。
const STROKE: Record<string, string> = {
  idle: 'var(--color-gray-300)',
  inactive: 'var(--color-gray-200)',
  flowing: 'var(--color-blue-500)',
  completed: 'var(--color-green-500)',
  failed: 'var(--color-red-500)',
  'failed-flowing': 'var(--color-red-500)',
};

function WorkflowEdgeView(props: EdgeProps<CanvasEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const { t } = useTranslation();
  const canvas = useCanvasContext();
  const label = data ? edgeLabel(data.orchestration, (route) => t(`automation.edge.routes.${route}`)) : '';
  const sourceNode = useInternalNode(source);
  const playback = canvas.edgeStateOf(id);
  const feedback = Boolean(data?.orchestration.feedback);
  const highlighted = canvas.highlightedEdgeId === id || selected;
  const stroke = playback ? STROKE[playback] ?? STROKE.idle : highlighted ? 'var(--color-orange-500)' : feedback ? 'var(--color-violet-400)' : 'var(--color-gray-400)';

  let path: string;
  let labelX: number;
  let labelY: number;
  if (source === target && sourceNode) {
    const x = sourceNode.internals.positionAbsolute.x;
    const y = sourceNode.internals.positionAbsolute.y;
    const width = sourceNode.measured.width ?? 260;
    const right = x + width + 80;
    const top = y - 80;
    path = `M ${sourceX} ${sourceY} L ${right} ${sourceY} L ${right} ${top} L ${targetX} ${top} L ${targetX} ${targetY}`;
    labelX = right;
    labelY = top;
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: highlighted ? 2.5 : 1.5,
          strokeDasharray: feedback || playback === 'inactive' ? '6 4' : undefined,
          animation: playback === 'flowing' || playback === 'failed-flowing' ? 'workflow-dash 1s linear infinite' : undefined,
        }}
        interactionWidth={18}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute px-1.5 py-0.5 text-[11px] leading-tight rounded-md border border-gray-200 bg-white text-gray-600 max-w-[220px] truncate cursor-pointer"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
            onDoubleClick={() => canvas.onEditEdge(id)}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export default memo(WorkflowEdgeView);
