// 设置页的全部状态与动作。各领域 hook 按依赖顺序调用：后面的 hook 可以用前面 hook 暴露的值，反之不行。
// 设置页所有页签共用这一个实例（SettingsPage 在切页签时不重挂载），未保存的输入与进行中的弹窗在切页签后仍在。
import type { SettingsProps } from './shared/settingsTypes';
import { useSettingsShared } from './hooks/useSettingsShared';
import { useGeneralSettings } from './hooks/useGeneralSettings';
import { useCommandSettings } from './hooks/useCommandSettings';
import { useModelSettings } from './hooks/useModelSettings';
import { useAddModelFlow } from './hooks/useAddModelFlow';
import { useUpdateSettings } from './hooks/useUpdateSettings';
import { useGatewaySettings } from './hooks/useGatewaySettings';
import { useHostAccessSettings } from './hooks/useHostAccessSettings';
import { useInitialSettingsLoad } from './hooks/useInitialSettingsLoad';
import { useDeleteConfirmation } from './hooks/useDeleteConfirmation';
import { deriveUpdateView } from './views/updateView';
import { deriveGatewayView } from './views/gatewayView';

export function useSettingsController(props: SettingsProps) {
  const s1 = { ...props, ...useSettingsShared() };
  const s2 = { ...s1, ...useGeneralSettings(s1) };
  const s3 = { ...s2, ...useCommandSettings(s2) };
  const s4 = { ...s3, ...useModelSettings(s3) };
  const s5 = { ...s4, ...useAddModelFlow(s4) };
  const s6 = { ...s5, ...useUpdateSettings(s5) };
  const s7 = { ...s6, ...useGatewaySettings(s6) };
  const s8 = { ...s7, ...useHostAccessSettings(s7) };
  useInitialSettingsLoad(s8);
  const s9 = { ...s8, ...useDeleteConfirmation(s8) };
  const s10 = { ...s9, ...deriveUpdateView(s9) };
  const s11 = { ...s10, ...deriveGatewayView(s10) };
  return s11;
}

export type SettingsController = ReturnType<typeof useSettingsController>;
