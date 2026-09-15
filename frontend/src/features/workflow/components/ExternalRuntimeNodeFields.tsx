// 工作流外部运行时节点的模式与模型（画布节点里的紧凑两行）。能力按名册给的 modes 显示，不按运行时名字写 if。
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { groupModelsByEndpoint } from '../../../components/runtime/runtimeSelection';
import { loadScopedModels } from '../../../components/runtime/scopedModels';
import { nodeModes, switchNodeMode, type NodeRuntimeMode } from '../lib/nodeRuntime';
import type { AgentEntry, WorkflowNodeData } from '../lib/types';

const FIELD_CLASS = 'nodrag w-full px-2 py-1 text-[11px] rounded-lg border border-gray-200 bg-white focus:outline-none';

export default function ExternalRuntimeNodeFields({ data, entry, onChange }: {
  data: Pick<WorkflowNodeData, 'agent' | 'model'>;
  entry: AgentEntry | undefined;
  onChange: (patch: Pick<WorkflowNodeData, 'agent' | 'model'>) => void;
}) {
  const { t } = useTranslation();
  const modes = nodeModes(entry);
  const mode: NodeRuntimeMode = data.agent.mode === 'scoped' ? 'scoped' : 'global';
  const [models, setModels] = useState<Array<{ id: string; alias?: string }>>([]);

  useEffect(() => {
    if (mode !== 'scoped') return;
    let cancelled = false;
    void loadScopedModels().then((list) => { if (!cancelled) setModels(list); });
    return () => { cancelled = true; };
  }, [mode]);

  const setModel = (value: string) => onChange({ agent: data.agent, model: value.trim() ? value : undefined });

  return (
    <div className="grid grid-cols-[88px_1fr] gap-1.5" data-testid="workflow-node-runtime">
      <select
        className={FIELD_CLASS}
        value={mode}
        title={t(`groupRuntime.mode_${mode}Hint`)}
        onChange={(event) => onChange(switchNodeMode(data, event.target.value as NodeRuntimeMode))}
      >
        {(['global', 'scoped'] as const).map((item) => (
          <option key={item} value={item} disabled={!modes.includes(item)}>{t(`groupRuntime.mode_${item}`)}</option>
        ))}
      </select>
      {mode === 'scoped' ? (
        <select className={FIELD_CLASS} value={data.model ?? ''} onChange={(event) => setModel(event.target.value)}>
          <option value="">{t('groupRuntime.scopedModelPlaceholder')}</option>
          {groupModelsByEndpoint(models).map((group) => (
            <optgroup key={group.endpoint || '_'} label={group.endpoint || t('groupRuntime.noEndpoint')}>
              {group.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </optgroup>
          ))}
        </select>
      ) : (
        <input className={FIELD_CLASS} value={data.model ?? ''} onChange={(event) => setModel(event.target.value)} placeholder={t('groupRuntime.modelPlaceholder')} />
      )}
    </div>
  );
}
