// 升级后重启、取消 OpenClaw 升级、取消 ClawOPT 升级的弹窗。
import { Activity, Check, Loader2, X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function UpdateModals({ ctx }: { ctx: SettingsController }) {
  const {
    closeUpdateRestartModal,
    handleConfirmCancelOpenClawUpdate,
    handleConfirmCancelUpdate,
    handleConfirmRestartUpdatedService,
    isCancellingOpenClawUpdate,
    isCancellingUpdate,
    isOpenClawUpdateCancelModalOpen,
    isUpdateCancelModalOpen,
    openClawUpdateCancelModalMessage,
    openClawUpdateCancelModalTitle,
    openClawUpdateCancelUnsafeDetail,
    openClawUpdateStatusInfo,
    setIsOpenClawUpdateCancelModalOpen,
    setIsUpdateCancelModalOpen,
    t,
    updateCancelModalMessage,
    updateCancelModalTitle,
    updateCancelUnsafeDetail,
    updateRestartModalDetail,
    updateRestartModalMessage,
    updateRestartModalStage,
    updateRestartModalTitle,
    updateRestartStepItems,
    updateStatusInfo,
  } = ctx;

  return (
    <>
      {updateRestartModalStage && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
                updateRestartModalStage === 'confirm'
                  ? 'bg-amber-100'
                  : updateRestartModalStage === 'success'
                    ? 'bg-emerald-100'
                    : updateRestartModalStage === 'failure'
                      ? 'bg-red-100'
                      : 'bg-blue-100'
              }`}>
                {updateRestartModalStage === 'confirm' ? (
                  <Activity className="h-6 w-6 text-amber-600" />
                ) : updateRestartModalStage === 'success' ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : updateRestartModalStage === 'failure' ? (
                  <X className="h-6 w-6 text-red-600" />
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
                )}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{updateRestartModalTitle}</h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">{updateRestartModalMessage}</p>
              {updateRestartModalStage !== 'confirm' ? (
                <div className="mt-4 space-y-2 text-left">
                  {updateRestartStepItems.map((step) => (
                    <div
                      key={step.id}
                      className={`rounded-xl border px-4 py-3 ${
                        step.status === 'completed'
                          ? 'border-emerald-200 bg-emerald-50'
                          : step.status === 'skipped'
                            ? 'border-gray-200 bg-gray-50'
                            : step.status === 'failed'
                              ? 'border-red-200 bg-red-50'
                              : step.status === 'running'
                                ? 'border-blue-200 bg-blue-50'
                                : 'border-gray-200 bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`flex h-7 w-7 items-center justify-center rounded-full ${
                          step.status === 'completed'
                            ? 'bg-emerald-100 text-emerald-600'
                            : step.status === 'skipped'
                              ? 'bg-gray-200 text-gray-500'
                              : step.status === 'failed'
                                ? 'bg-red-100 text-red-600'
                                : step.status === 'running'
                                  ? 'bg-blue-100 text-blue-600'
                                  : 'bg-gray-200 text-gray-500'
                        }`}>
                          {step.status === 'completed' ? (
                            <Check className="h-4 w-4" />
                          ) : step.status === 'failed' ? (
                            <X className="h-4 w-4" />
                          ) : step.status === 'running' ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Activity className="h-4 w-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold text-gray-900">{step.label}</p>
                            <span className={`shrink-0 text-xs font-medium ${
                              step.status === 'completed'
                                ? 'text-emerald-700'
                                : step.status === 'failed'
                                  ? 'text-red-700'
                                  : step.status === 'running'
                                    ? 'text-blue-700'
                                    : 'text-gray-500'
                            }`}>
                              {step.statusLabel}
                            </span>
                          </div>
                          {step.status === 'skipped' && step.skipReason ? (
                            <p className="mt-1 whitespace-pre-wrap text-xs text-gray-500">{step.skipReason}</p>
                          ) : step.detail ? (
                            <p className="mt-1 whitespace-pre-wrap break-all text-xs text-gray-500">{step.detail}</p>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {updateRestartModalDetail && updateRestartModalStage === 'failure' ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{updateRestartModalDetail}</p>
                </div>
              ) : null}
            </div>
            {updateRestartModalStage === 'confirm' ? (
              <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeUpdateRestartModal}
                  className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRestartUpdatedService()}
                  className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('settings.about.restartServiceConfirmAction')}
                </button>
              </div>
            ) : updateRestartModalStage === 'success' || updateRestartModalStage === 'failure' ? (
              <div className="border-t border-gray-100 bg-gray-50 p-4">
                <button
                  type="button"
                  onClick={closeUpdateRestartModal}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700"
                >
                  {t('common.gotIt')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {isOpenClawUpdateCancelModalOpen && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => {
              if (!isCancellingOpenClawUpdate) {
                setIsOpenClawUpdateCancelModalOpen(false);
              }
            }}
          />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${openClawUpdateStatusInfo?.canCancel ? 'bg-amber-100' : 'bg-blue-100'}`}>
                <Activity className={`h-6 w-6 ${openClawUpdateStatusInfo?.canCancel ? 'text-amber-600' : 'text-blue-600'}`} />
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{openClawUpdateCancelModalTitle}</h3>
              <p className="text-sm text-gray-500">{openClawUpdateCancelModalMessage}</p>
              {!openClawUpdateStatusInfo?.canCancel && openClawUpdateCancelUnsafeDetail ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{openClawUpdateCancelUnsafeDetail}</p>
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={() => setIsOpenClawUpdateCancelModalOpen(false)}
                disabled={isCancellingOpenClawUpdate}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {openClawUpdateStatusInfo?.canCancel ? t('settings.openclawUpdate.updateCancelKeepRunning') : t('common.gotIt')}
              </button>
              {openClawUpdateStatusInfo?.canCancel ? (
                <button
                  type="button"
                  onClick={() => void handleConfirmCancelOpenClawUpdate()}
                  disabled={isCancellingOpenClawUpdate}
                  className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isCancellingOpenClawUpdate ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('settings.openclawUpdate.updateStoppingButton')}
                    </span>
                  ) : (
                    t('settings.openclawUpdate.updateCancelConfirmAction')
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {isUpdateCancelModalOpen && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
            onClick={() => {
              if (!isCancellingUpdate) {
                setIsUpdateCancelModalOpen(false);
              }
            }}
          />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full ${updateStatusInfo?.canCancel ? 'bg-amber-100' : 'bg-blue-100'}`}>
                <Activity className={`h-6 w-6 ${updateStatusInfo?.canCancel ? 'text-amber-600' : 'text-blue-600'}`} />
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">{updateCancelModalTitle}</h3>
              <p className="text-sm text-gray-500">{updateCancelModalMessage}</p>
              {!updateStatusInfo?.canCancel && updateCancelUnsafeDetail ? (
                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left">
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{t('common.details')}</p>
                  <p className="whitespace-pre-wrap break-all text-xs text-gray-500">{updateCancelUnsafeDetail}</p>
                </div>
              ) : null}
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={() => setIsUpdateCancelModalOpen(false)}
                disabled={isCancellingUpdate}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {updateStatusInfo?.canCancel ? t('settings.about.updateCancelKeepRunning') : t('common.gotIt')}
              </button>
              {updateStatusInfo?.canCancel ? (
                <button
                  type="button"
                  onClick={() => void handleConfirmCancelUpdate()}
                  disabled={isCancellingUpdate}
                  className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isCancellingUpdate ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('settings.about.updateStoppingButton')}
                    </span>
                  ) : (
                    t('settings.about.updateCancelConfirmAction')
                  )}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
