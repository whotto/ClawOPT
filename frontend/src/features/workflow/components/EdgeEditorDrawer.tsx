// 边编辑抽屉：路由、条件（主体预设 / 运算符 / 带类型的值）、反馈循环（上限、历史节点）。
// 保存前按与服务端同判据校验整张图，不通过就停在抽屉里显示原因。
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validateForSave } from '../lib/graph';
import { CONDITION_OPERATORS, ROUTES, type ConditionOperator, type EdgeOrchestration, type Route, type WfEdge, type WfNode } from '../lib/types';
import { ErrorBanner, Field, Modal, Toggle, inputClass, primaryButton, secondaryButton, selectClass } from './ui';

type Subject = 'none' | 'output' | 'outputJson' | 'error' | 'custom';
type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object';

const NUMERIC: ConditionOperator[] = ['greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal'];
const ARRAY_OPS: ConditionOperator[] = ['in', 'not_in'];
const NO_VALUE: ConditionOperator[] = ['exists', 'not_exists'];

function subjectOf(path: string | undefined): { subject: Subject; field: string } {
  if (!path) return { subject: 'none', field: '' };
  if (path === 'output') return { subject: 'output', field: '' };
  if (path === 'error') return { subject: 'error', field: '' };
  if (path === 'outputJson' || path.startsWith('outputJson.')) return { subject: 'outputJson', field: path.slice('outputJson.'.length) };
  return { subject: 'custom', field: path };
}

function typeOf(value: unknown): ValueType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'string';
}

export function parseTypedValue(type: ValueType, text: string): { ok: true; value: unknown } | { ok: false } {
  if (type === 'string') return { ok: true, value: text };
  if (type === 'null') return { ok: true, value: null };
  try {
    const value = JSON.parse(text);
    if (type === 'number' && typeof value === 'number' && Number.isFinite(value)) return { ok: true, value };
    if (type === 'boolean' && typeof value === 'boolean') return { ok: true, value };
    if (type === 'array' && Array.isArray(value)) return { ok: true, value };
    if (type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
  } catch {
    // 落到失败
  }
  return { ok: false };
}

/** 反馈边的循环体（header 前向可达 ∩ 前向可达 latch），用来选「历史节点」。 */
function loopBody(edge: WfEdge, nodes: WfNode[], edges: WfEdge[]): string[] {
  const out = new Map<string, string[]>();
  for (const item of edges) if (!item.data.orchestration.feedback && item.id !== edge.id) (out.get(item.source) ?? out.set(item.source, []).get(item.source)!).push(item.target);
  const reach = (from: string) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) for (const next of out.get(stack.pop()!) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    return seen;
  };
  if (edge.source === edge.target) return [edge.source];
  const fromHeader = reach(edge.target);
  return nodes.map((node) => node.id).filter((id) => fromHeader.has(id) && reach(id).has(edge.source));
}

export default function EdgeEditorDrawer({ edge, nodes, edges, onSave, onClose, describeIssue }: {
  edge: WfEdge;
  nodes: WfNode[];
  edges: WfEdge[];
  onSave: (orchestration: EdgeOrchestration) => void;
  onClose: () => void;
  describeIssue: (issue: { reason: string; params?: Record<string, string | number> }) => string;
}) {
  const { t } = useTranslation();
  const initial = edge.data.orchestration;
  const [route, setRoute] = useState<Route>(initial.route);
  const initialSubject = subjectOf(initial.condition?.path);
  const [subject, setSubject] = useState<Subject>(initialSubject.subject);
  const [field, setField] = useState(initialSubject.field);
  const [operator, setOperator] = useState<ConditionOperator>(initial.condition?.operator ?? 'contains');
  const [valueType, setValueType] = useState<ValueType>(typeOf(initial.condition?.value));
  const [valueText, setValueText] = useState(() => {
    const value = initial.condition?.value;
    if (value === undefined) return '';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
  const [feedback, setFeedback] = useState(Boolean(initial.feedback));
  const [maxIterations, setMaxIterations] = useState(String(initial.feedback?.maxIterations ?? 3));
  const [historyNode, setHistoryNode] = useState(initial.feedback?.loopId ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const body = useMemo(() => loopBody(edge, nodes, edges), [edge, nodes, edges]);
  const titleOf = (id: string) => nodes.find((node) => node.id === id)?.data.title ?? id;

  const effectiveType: ValueType = NUMERIC.includes(operator) ? 'number' : ARRAY_OPS.includes(operator) ? 'array' : valueType;

  const changeRoute = (next: Route) => {
    setRoute(next);
    if (next === 'failure' && (subject === 'output' || subject === 'outputJson')) setSubject('error');
    if (next === 'success' && subject === 'error') setSubject('output');
  };

  const submit = () => {
    const orchestration: EdgeOrchestration = { route };
    if (subject !== 'none') {
      const path = subject === 'output' ? 'output' : subject === 'error' ? 'error' : subject === 'outputJson' ? (field.trim() ? `outputJson.${field.trim()}` : 'outputJson') : field.trim();
      if (NO_VALUE.includes(operator)) orchestration.condition = { path, operator };
      else {
        const parsed = parseTypedValue(effectiveType, valueText);
        if (!parsed.ok) return setProblem(t('automation.edge.valueInvalid', { type: t(`automation.edge.valueTypes.${effectiveType}`) }));
        orchestration.condition = { path, operator, value: parsed.value };
      }
    }
    if (feedback) {
      const max = Number(maxIterations);
      if (!Number.isInteger(max) || max < 1 || max > 100) return setProblem(t('automation.edge.maxIterationsInvalid'));
      orchestration.feedback = { maxIterations: max, ...(historyNode ? { loopId: historyNode } : {}) };
    }
    const nextEdges = edges.map((item) => (item.id === edge.id ? { ...item, data: { orchestration } } : item));
    const issue = validateForSave(nodes.map((node) => ({ ...node, data: { ...node.data, input: node.data.input || '-' } })), nextEdges);
    // 只拦与这条边有关的问题（循环、成环、条件路径）；孤立节点这类整图问题留给保存时报。
    if (issue && (issue.reason.startsWith('loop') || ['forwardCycle', 'invalidConditionPath', 'duplicateLoopId'].includes(issue.reason))) return setProblem(describeIssue(issue));
    onSave(orchestration);
  };

  return (
    <Modal
      title={t('automation.edge.title', { source: titleOf(edge.source), target: titleOf(edge.target) })}
      onClose={onClose}
      width="max-w-lg"
      footer={(
        <>
          <button className={secondaryButton} onClick={onClose}>{t('common.cancel')}</button>
          <button className={primaryButton} onClick={submit}>{t('common.save')}</button>
        </>
      )}
    >
      {problem && <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />}
      <Field label={t('automation.edge.route')} hint={t(`automation.edge.routeHelp.${route}`)}>
        <select className={selectClass} value={route} onChange={(event) => changeRoute(event.target.value as Route)}>
          {ROUTES.map((item) => <option key={item} value={item}>{t(`automation.edge.routes.${item}`)}</option>)}
        </select>
      </Field>
      <Field label={t('automation.edge.subject')}>
        <select className={selectClass} value={subject} onChange={(event) => setSubject(event.target.value as Subject)}>
          {(['none', 'output', 'outputJson', 'error', 'custom'] as Subject[]).map((item) => <option key={item} value={item}>{t(`automation.edge.subjects.${item}`)}</option>)}
        </select>
      </Field>
      {(subject === 'outputJson' || subject === 'custom') && (
        <Field label={subject === 'outputJson' ? t('automation.edge.jsonField') : t('automation.edge.customPath')} hint={subject === 'outputJson' ? t('automation.edge.jsonFieldHint') : undefined}>
          <input className={inputClass} value={field} onChange={(event) => setField(event.target.value)} placeholder={subject === 'outputJson' ? 'decision' : 'outputJson.result.score'} />
        </Field>
      )}
      {subject !== 'none' && (
        <>
          <Field label={t('automation.edge.operator')} hint={t(`automation.edge.operatorHelp.${operator}`)}>
            <select className={selectClass} value={operator} onChange={(event) => setOperator(event.target.value as ConditionOperator)}>
              {CONDITION_OPERATORS.map((item) => <option key={item} value={item}>{t(`automation.edge.operators.${item}`)}</option>)}
            </select>
          </Field>
          {!NO_VALUE.includes(operator) && (
            <div className="grid grid-cols-3 gap-2">
              <Field label={t('automation.edge.valueType')}>
                <select className={selectClass} value={effectiveType} disabled={NUMERIC.includes(operator) || ARRAY_OPS.includes(operator)} onChange={(event) => setValueType(event.target.value as ValueType)}>
                  {(['string', 'number', 'boolean', 'null', 'array', 'object'] as ValueType[]).map((item) => <option key={item} value={item}>{t(`automation.edge.valueTypes.${item}`)}</option>)}
                </select>
              </Field>
              <div className="col-span-2">
                <Field label={t('automation.edge.value')}>
                  <input className={inputClass} value={valueText} disabled={effectiveType === 'null'} onChange={(event) => setValueText(event.target.value)} placeholder={effectiveType === 'array' ? '["PASS","OK"]' : effectiveType === 'string' ? 'PASS' : ''} />
                </Field>
              </div>
            </div>
          )}
        </>
      )}
      <div className="border-t border-gray-100 pt-4 space-y-3">
        <Toggle checked={feedback} onChange={setFeedback} label={t('automation.edge.feedback')} />
        <p className="text-xs text-gray-500">{t('automation.edge.feedbackHelp')}</p>
        {feedback && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('automation.edge.maxIterations')}>
              <input className={inputClass} type="number" min={1} max={100} value={maxIterations} onChange={(event) => setMaxIterations(event.target.value)} />
            </Field>
            <Field label={t('automation.edge.historyNode')} hint={t('automation.edge.historyNodeHint')}>
              <select className={selectClass} value={historyNode} onChange={(event) => setHistoryNode(event.target.value)}>
                <option value="">{titleOf(edge.target)}</option>
                {body.filter((id) => id !== edge.target).map((id) => <option key={id} value={id}>{titleOf(id)}</option>)}
              </select>
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
