// 共用删除确认弹窗的执行分支（主机 / 指令 / 模型 / 端点）。
import { saveConfig } from '../../../api/config';
import { deleteCommand } from '../../../api/commands';
import { deleteModel } from '../../../api/models';
import { EMPTY_INLINE_ERROR } from '../shared/settingsTypes';
import { resolveStructuredErrorDisplay } from '../shared/settingsHelpers';
import { deleteEndpoint } from '../../../api/endpoints';
import type { useGatewaySettings } from './useGatewaySettings';
import type { useSettingsShared } from './useSettingsShared';
import type { useCommandSettings } from './useCommandSettings';
import type { useModelSettings } from './useModelSettings';

export function useDeleteConfirmation(deps: Pick<ReturnType<typeof useGatewaySettings> & ReturnType<typeof useSettingsShared> & ReturnType<typeof useCommandSettings> & ReturnType<typeof useModelSettings>, 'allowedHosts' | 'deleteTarget' | 'fetchCommands' | 'fetchEndpoints' | 'fetchGlobalFallbacks' | 'fetchImageGenerationModelConfig' | 'fetchModels' | 'setAllowedHosts' | 'setDeleteTarget' | 'setIsDeleteModalOpen' | 'setModelActionError' | 't'>) {
  const { allowedHosts, deleteTarget, fetchCommands, fetchEndpoints, fetchGlobalFallbacks, fetchImageGenerationModelConfig, fetchModels, setAllowedHosts, setDeleteTarget, setIsDeleteModalOpen, setModelActionError, t } = deps;

  const executeDelete = async () => {
    if (!deleteTarget) return;
    try {
      if (deleteTarget.type === 'host') {
        const updated = allowedHosts.filter(h => h !== deleteTarget.value);
        const res = await saveConfig({ allowedHosts: updated });
        if (res.ok) setAllowedHosts(updated);
      } else if (deleteTarget.type === 'command') {
        const res = await deleteCommand(deleteTarget.id);
        if (res.ok) fetchCommands();
      } else if (deleteTarget.type === 'model') {
        const res = await deleteModel({ id: deleteTarget.id });
        if (res.ok) {
          setModelActionError(EMPTY_INLINE_ERROR);
          fetchModels();
          fetchImageGenerationModelConfig();
          fetchGlobalFallbacks();
  
        } else {
          const data = await res.json().catch(() => ({}));
          setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.deleteModelFailed'));
        }
      } else if (deleteTarget.type === 'endpoint') {
        const res = await deleteEndpoint({ endpoint: deleteTarget.name });
        if (res.ok) {
          setModelActionError(EMPTY_INLINE_ERROR);
          fetchModels();
          fetchImageGenerationModelConfig();
          fetchGlobalFallbacks();
          fetchEndpoints();
  
        } else {
          const data = await res.json().catch(() => ({}));
          setModelActionError(resolveStructuredErrorDisplay(data, t, 'settings.models.deleteEndpointFailed'));
        }
      }
    } catch (err) {
      console.error(err);
      if (deleteTarget.type === 'model') {
        setModelActionError({
          message: t('settings.models.deleteModelFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      } else if (deleteTarget.type === 'endpoint') {
        setModelActionError({
          message: t('settings.models.deleteEndpointFailed'),
          detail: err instanceof Error && err.message.trim() ? err.message.trim() : '',
        });
      }
    } finally {
      setIsDeleteModalOpen(false);
      setDeleteTarget(null);
    }
  };

  return {
    executeDelete,
  };
}
