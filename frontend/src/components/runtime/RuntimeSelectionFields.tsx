import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listModels } from '../../api/models';
import { MODAL_FIELD_LABEL_CLASS, MODAL_TEXT_INPUT_CLASS } from '../../app/sidebar/sidebarTypes';
import {
  REASONING_EFFORTS,
  effectiveMode,
  groupModelsByEndpoint,
  supportedModes,
  switchMode,
  type RuntimeOption,
  type RuntimeSelectionConfig,
} from './runtimeSelection';

/** ClawOPT 模型配置（scoped 模式的模型下拉），同一页面里只取一次。 */
let modelsCache: Promise<Array<{ id: string; alias?: string }>> | null = null;
function loadModels() {
  if (!modelsCache) {
    modelsCache = listModels()
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data.models) ? data.models : [];
      })
      .catch(() => {
        modelsCache = null;
        return [];
      });
  }
  return modelsCache;
}

/**
 * 外部运行时的配置项：检测状态、模式（global：CLI 用自己的登录与模型；scoped：ClawOPT 选服务商与模型，CLI 只连本地代理）、
 * 模型、推理强度、工作目录。群成员运行时与外部运行时单聊共用。按能力（`option.modes`）显示，不按运行时名字写 if。
 */
export default function RuntimeSelectionFields({ option, config, onChange }: {
  option: RuntimeOption;
  config: RuntimeSelectionConfig;
  onChange: (next: RuntimeSelectionConfig) => void;
}) {
  const { t } = useTranslation();
  const modes = supportedModes(option);
  const mode = effectiveMode(option, config);
  const [models, setModels] = useState<Array<{ id: string; alias?: string }>>([]);

  useEffect(() => {
    if (mode !== 'scoped') return;
    let cancelled = false;
    void loadModels().then((list) => { if (!cancelled) setModels(list); });
    return () => { cancelled = true; };
  }, [mode]);

  const set = (key: string, value: unknown) => onChange({ ...config, mode, [key]: value });
  const groups = groupModelsByEndpoint(models);

  return (
    <div className="space-y-3" data-testid="runtime-selection-fields">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`px-2 py-0.5 rounded-full border ${option.available ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
          {option.available ? t('groupRuntime.detected', { version: option.version || '?' }) : t('groupRuntime.notDetected')}
        </span>
        {option.approvals && <span className="px-2 py-0.5 rounded-full border border-gray-200 text-gray-500">{t('groupRuntime.approvals')}</span>}
        {option.probedAt && <span className="text-gray-400">{t('groupRuntime.probedAt', { time: new Date(option.probedAt).toLocaleTimeString() })}</span>}
      </div>

      <div>
        <label className={MODAL_FIELD_LABEL_CLASS}>{t('groupRuntime.mode')}</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(['global', 'scoped'] as const).map((item) => {
            const enabled = modes.includes(item);
            return (
              <label
                key={item}
                className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm ${mode === item ? 'border-orange-300 bg-amber-50' : 'border-gray-200 bg-white'} ${enabled ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
              >
                <input type="radio" className="mt-1" disabled={!enabled} checked={mode === item} onChange={() => onChange(switchMode({ ...config, mode }, item))} />
                <span>
                  <span className="font-medium text-gray-800">{t(`groupRuntime.mode_${item}`)}</span>
                  <span className="block text-xs text-gray-500">{t(`groupRuntime.mode_${item}Hint`)}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={MODAL_FIELD_LABEL_CLASS}>{t('groupRuntime.model')}</label>
          {mode === 'scoped' ? (
            <select className={MODAL_TEXT_INPUT_CLASS} value={String(config.model ?? '')} onChange={(event) => set('model', event.target.value)}>
              <option value="">{t('groupRuntime.scopedModelPlaceholder')}</option>
              {groups.map((group) => (
                <optgroup key={group.endpoint || '_'} label={group.endpoint || t('groupRuntime.noEndpoint')}>
                  {group.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </optgroup>
              ))}
            </select>
          ) : (
            <input className={MODAL_TEXT_INPUT_CLASS} value={String(config.model ?? '')} onChange={(event) => set('model', event.target.value)} placeholder={t('groupRuntime.modelPlaceholder')} />
          )}
        </div>
        <div>
          <label className={MODAL_FIELD_LABEL_CLASS}>{t('groupRuntime.reasoningEffort')}</label>
          <select className={MODAL_TEXT_INPUT_CLASS} value={String(config.reasoningEffort ?? '')} onChange={(event) => set('reasoningEffort', event.target.value)}>
            <option value="">{t('groupRuntime.reasoningDefault')}</option>
            {REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={MODAL_FIELD_LABEL_CLASS}>{t('groupRuntime.workingDir')}</label>
          <input className={MODAL_TEXT_INPUT_CLASS} value={String(config.workingDir ?? '')} onChange={(event) => set('workingDir', event.target.value)} placeholder="/srv/project" />
        </div>
      </div>
      {mode === 'scoped' && groups.length === 0 && <p className="text-xs text-amber-700">{t('groupRuntime.noScopedModels')}</p>}
      {mode === 'scoped' && <p className="text-xs text-gray-400">{t('groupRuntime.scopedKeyHint')}</p>}
      {!option.available && <p className="text-xs text-amber-700">{t('groupRuntime.notInstalledHint')}</p>}
    </div>
  );
}
