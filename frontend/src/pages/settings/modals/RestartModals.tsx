// 浏览器有头模式切换与网关重启的流程弹窗。
import { Activity, Check, Loader2, X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function RestartModals({ ctx }: { ctx: SettingsController }) {
  const {
    browserHeadedModeConfirmingEnable,
    browserHeadedModeModalDetail,
    browserHeadedModeModalMessage,
    browserHeadedModeModalStage,
    browserHeadedModeModalTitle,
    closeBrowserHeadedModeModal,
    closeGatewayRestartModal,
    gatewayRestartModalDetail,
    gatewayRestartModalMessage,
    gatewayRestartModalStage,
    gatewayRestartModalTitle,
    handleConfirmBrowserHeadedModeToggle,
    handleConfirmRestartGateway,
    t,
  } = ctx;

  return (
    <>
      {browserHeadedModeModalStage && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
                browserHeadedModeModalStage === 'confirm'
                  ? 'bg-amber-100'
                  : browserHeadedModeModalStage === 'success'
                    ? 'bg-emerald-100'
                    : browserHeadedModeModalStage === 'failure'
                      ? 'bg-red-100'
                      : 'bg-blue-100'
              }`}>
                {browserHeadedModeModalStage === 'confirm' ? (
                  <Activity className="h-6 w-6 text-amber-600" />
                ) : browserHeadedModeModalStage === 'success' ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : browserHeadedModeModalStage === 'failure' ? (
                  <X className="h-6 w-6 text-red-600" />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                )}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{browserHeadedModeModalTitle}</h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{browserHeadedModeModalMessage}</p>
              {browserHeadedModeModalDetail && browserHeadedModeModalStage === 'failure' ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{browserHeadedModeModalDetail}</p>
                </div>
              ) : null}
            </div>
            {browserHeadedModeModalStage === 'confirm' ? (
              <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeBrowserHeadedModeModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmBrowserHeadedModeToggle()}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {browserHeadedModeConfirmingEnable
                    ? t('settings.gateway.browserHeadedModeConfirmEnableAction')
                    : t('settings.gateway.browserHeadedModeConfirmDisableAction')}
                </button>
              </div>
            ) : browserHeadedModeModalStage === 'success' || browserHeadedModeModalStage === 'failure' ? (
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeBrowserHeadedModeModal}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('common.gotIt')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {gatewayRestartModalStage && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
                gatewayRestartModalStage === 'confirm'
                  ? 'bg-amber-100'
                  : gatewayRestartModalStage === 'success'
                    ? 'bg-emerald-100'
                    : gatewayRestartModalStage === 'failure'
                      ? 'bg-red-100'
                      : 'bg-blue-100'
              }`}>
                {gatewayRestartModalStage === 'confirm' ? (
                  <Activity className="h-6 w-6 text-amber-600" />
                ) : gatewayRestartModalStage === 'success' ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : gatewayRestartModalStage === 'failure' ? (
                  <X className="h-6 w-6 text-red-600" />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                )}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{gatewayRestartModalTitle}</h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{gatewayRestartModalMessage}</p>
              {gatewayRestartModalDetail && gatewayRestartModalStage === 'failure' ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{gatewayRestartModalDetail}</p>
                </div>
              ) : null}
            </div>
            {gatewayRestartModalStage === 'confirm' ? (
              <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeGatewayRestartModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRestartGateway()}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('settings.gateway.restartGatewayConfirmAction')}
                </button>
              </div>
            ) : gatewayRestartModalStage === 'success' || gatewayRestartModalStage === 'failure' ? (
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeGatewayRestartModal}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('common.gotIt')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
