// 外部运行时选择（群成员运行时、外部运行时单聊共用）的纯逻辑：选项文案、模式、scoped 模型分组、配置清洗。
// 界面按后端给的能力（modes）显示配置项，不按运行时名字写 if。

/** 后端 GET /api/runtime/member-runtimes 的一项。 */
export type RuntimeOption = {
  id: string;
  name: string;
  kind: 'cli' | 'remote';
  available: boolean;
  version: string | null;
  probedAt?: string;
  modes?: Array<'global' | 'scoped'>;
  approvals?: boolean;
  nativeCompact?: boolean;
};

export type RuntimeSelectionConfig = {
  mode?: 'global' | 'scoped';
  model?: string;
  reasoningEffort?: string;
  workingDir?: string;
  [key: string]: unknown;
};

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 这个运行时支持的模式；后端没给（老后端）时只认 global。 */
export function supportedModes(option: RuntimeOption | undefined): Array<'global' | 'scoped'> {
  const modes = option?.modes?.filter((mode) => mode === 'global' || mode === 'scoped') ?? [];
  return modes.length > 0 ? modes : ['global'];
}

/** 当前生效的模式：配置里选的不被支持时回落到第一个支持的。 */
export function effectiveMode(option: RuntimeOption | undefined, config: RuntimeSelectionConfig): 'global' | 'scoped' {
  const modes = supportedModes(option);
  return config.mode && modes.includes(config.mode) ? config.mode : modes[0];
}

/** ClawOPT 模型配置（GET /api/models）按端点分组：`<端点>/<模型>`。没有端点前缀的归到空组。 */
export function groupModelsByEndpoint(models: Array<{ id: string; alias?: string }>): Array<{ endpoint: string; models: Array<{ id: string; label: string }> }> {
  const groups = new Map<string, Array<{ id: string; label: string }>>();
  for (const model of models) {
    if (!model?.id) continue;
    const slash = model.id.indexOf('/');
    const endpoint = slash > 0 ? model.id.slice(0, slash) : '';
    const name = slash > 0 ? model.id.slice(slash + 1) : model.id;
    const list = groups.get(endpoint) ?? [];
    list.push({ id: model.id, label: model.alias ? `${model.alias} (${name})` : name });
    groups.set(endpoint, list);
  }
  return [...groups.entries()].map(([endpoint, list]) => ({ endpoint, models: list }));
}

/** 切换模式时清掉另一种模式才有意义的值（scoped 的模型是 `<端点>/<模型>`，global 的是 CLI 自己的模型名）。 */
export function switchMode(config: RuntimeSelectionConfig, mode: 'global' | 'scoped'): RuntimeSelectionConfig {
  if (config.mode === mode) return config;
  const { model: _model, ...rest } = config;
  return { ...rest, mode };
}

/** 保存前的清洗：去掉空串，模式只留合法值。 */
export function cleanSelectionConfig(config: RuntimeSelectionConfig, option: RuntimeOption | undefined): RuntimeSelectionConfig {
  const out: RuntimeSelectionConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && !value.trim()) continue;
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value.trim() : value;
  }
  if (option?.kind === 'cli') out.mode = effectiveMode(option, config);
  if (out.reasoningEffort && !(REASONING_EFFORTS as readonly string[]).includes(String(out.reasoningEffort))) delete out.reasoningEffort;
  return out;
}

/** 下拉框里一项的文案（带检测状态）。 */
export function runtimeOptionLabel(option: RuntimeOption, t: (key: string, params?: Record<string, unknown>) => string): string {
  if (option.kind === 'remote') return t('groupRuntime.remoteOption');
  if (!option.available) return t('groupRuntime.notInstalledOption', { name: option.name });
  return option.version ? t('groupRuntime.installedOption', { name: option.name, version: option.version }) : option.name;
}

/** 可以发起外部运行时单聊的选项：本机 CLI（远程 OpenClaw 只能当群成员）。 */
export function chatCapableRuntimes(options: RuntimeOption[]): RuntimeOption[] {
  return options.filter((option) => option.kind === 'cli');
}
