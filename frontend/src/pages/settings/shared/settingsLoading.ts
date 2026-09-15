// 设置页各领域各自的「进行中」计数。此前所有页签共用一个 isLoading：
// 在模型页点保存，网关页的保存 / 测试按钮也跟着转圈变灰——一个领域的请求不该锁住另一个领域。
// 用计数而不是布尔：同一领域里两个请求交叠时，先结束的那个不能把还在进行的那个标成「空闲」。

export type SettingsLoadingArea = 'general' | 'commands' | 'models' | 'gateway';

export type SettingsLoadingState = Readonly<Record<SettingsLoadingArea, number>>;

export const EMPTY_SETTINGS_LOADING: SettingsLoadingState = Object.freeze({ general: 0, commands: 0, models: 0, gateway: 0 });

export function applySettingsAreaLoading(state: SettingsLoadingState, area: SettingsLoadingArea, loading: boolean): SettingsLoadingState {
  const next = Math.max(0, state[area] + (loading ? 1 : -1));
  if (next === state[area]) return state;
  return { ...state, [area]: next };
}

export function isSettingsAreaLoading(state: SettingsLoadingState, area: SettingsLoadingArea): boolean {
  return state[area] > 0;
}
