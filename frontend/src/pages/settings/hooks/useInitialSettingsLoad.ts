// 进入设置页时一次性拉取配置并分发到各页签的状态。
import { useEffect } from 'react';
import { getConfig } from '../../../api/config';
import { normalizeChatHistoryPageRounds, persistChatHistoryPageRounds } from '../../../utils/historyPagination';
import { normalizePreviewTimeoutSeconds } from '../shared/settingsHelpers';
import { applyLanguagePreference } from '../../../i18n';
import type { useCommandSettings } from './useCommandSettings';
import type { useModelSettings } from './useModelSettings';
import type { useHostAccessSettings } from './useHostAccessSettings';
import type { useGeneralSettings } from './useGeneralSettings';
import type { useGatewaySettings } from './useGatewaySettings';

export function useInitialSettingsLoad(deps: Pick<ReturnType<typeof useCommandSettings> & ReturnType<typeof useModelSettings> & ReturnType<typeof useHostAccessSettings> & ReturnType<typeof useGeneralSettings> & ReturnType<typeof useGatewaySettings>, 'fetchCommands' | 'fetchEndpoints' | 'fetchGlobalFallbacks' | 'fetchImageGenerationModelConfig' | 'fetchMaxPermissionsState' | 'fetchModels' | 'setAiName' | 'setAllowedHosts' | 'setHasLoginPassword' | 'setHasPassword' | 'setHasToken' | 'setHistoryPageRoundsInput' | 'setLoginEnabled' | 'setPreviewTimeoutSecondsInput' | 'setUrl'>) {
  const { fetchCommands, fetchEndpoints, fetchGlobalFallbacks, fetchImageGenerationModelConfig, fetchMaxPermissionsState, fetchModels, setAiName, setAllowedHosts, setHasLoginPassword, setHasPassword, setHasToken, setHistoryPageRoundsInput, setLoginEnabled, setPreviewTimeoutSecondsInput, setUrl } = deps;

  useEffect(() => {
    getConfig()
      .then(r => r.json())
      .then(data => {
        setUrl(data.gatewayUrl || '');
        setHasToken(Boolean(data.hasToken));
        setHasPassword(Boolean(data.hasPassword));
        setHasLoginPassword(Boolean(data.hasLoginPassword));
        if (data.aiName) setAiName(data.aiName);
        if (data.loginEnabled !== undefined) setLoginEnabled(data.loginEnabled);
        if (data.allowedHosts) setAllowedHosts(data.allowedHosts);
        if (data.historyPageRounds !== undefined) {
          const nextHistoryPageRounds = normalizeChatHistoryPageRounds(data.historyPageRounds);
          setHistoryPageRoundsInput(String(nextHistoryPageRounds));
          persistChatHistoryPageRounds(nextHistoryPageRounds);
        }
        if (data.previewConversionTimeoutSeconds !== undefined) {
          setPreviewTimeoutSecondsInput(String(normalizePreviewTimeoutSeconds(data.previewConversionTimeoutSeconds)));
        }
        if (data.language) {
          void applyLanguagePreference(data.language);
        }
      })
      .catch(console.error);

    fetchCommands();
    fetchModels();
    fetchImageGenerationModelConfig();
    fetchGlobalFallbacks();
    fetchEndpoints();

    fetchMaxPermissionsState().catch(console.error);
  }, []);
}
