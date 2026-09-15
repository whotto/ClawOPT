import { RefreshCw, AlertTriangle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNoProviderPrompt } from './useNoProviderPrompt';
import { useStaleClientCheck } from './useStaleClientCheck';

type ShellBannersProps = {
  isConnected: boolean;
  /** 只在对话区（单聊 / 群聊）提示「没有服务商」：设置页本身就是去配置的地方。 */
  inConversation: boolean;
  modelsLoaded: boolean;
  modelCount: number;
  modelsConfigReadFailed: boolean;
  onOpenModelSettings: () => void;
};

/** 壳层主区域顶部的引导横幅：客户端版本过期（刷新）、没有可用的模型服务商。渲染在 AccessProvider 之内。 */
export default function ShellBanners(props: ShellBannersProps) {
  const { t } = useTranslation();
  const stale = useStaleClientCheck(props.isConnected);
  const noProvider = useNoProviderPrompt({
    modelsLoaded: props.modelsLoaded,
    modelCount: props.modelCount,
    modelsConfigReadFailed: props.modelsConfigReadFailed,
  });
  const showNoProvider = props.inConversation && noProvider !== 'hidden';

  if (!stale.showReloadPrompt && !showNoProvider) return null;

  return (
    <div className="flex-shrink-0 flex flex-col gap-2 px-4 sm:px-6 pt-3 bg-white">
      {stale.showReloadPrompt && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
          <RefreshCw className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 min-w-0 break-words">{t('onboarding.staleClient.message')}</span>
          <button
            type="button"
            onClick={stale.reload}
            className="h-8 px-3 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            {t('onboarding.staleClient.reload')}
          </button>
          <button
            type="button"
            onClick={stale.dismiss}
            className="shrink-0 text-blue-400 hover:text-blue-600"
            aria-label={t('onboarding.staleClient.later')}
            title={t('onboarding.staleClient.later')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      {showNoProvider && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 min-w-0 break-words">
            {noProvider === 'manage' ? t('onboarding.noProvider.manageMessage') : t('onboarding.noProvider.askAdminMessage')}
          </span>
          {noProvider === 'manage' && (
            <button
              type="button"
              onClick={props.onOpenModelSettings}
              className="h-8 px-3 rounded-lg text-sm font-semibold bg-white text-amber-700 border border-amber-300 hover:bg-amber-100 transition-colors"
            >
              {t('onboarding.noProvider.openSettings')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
