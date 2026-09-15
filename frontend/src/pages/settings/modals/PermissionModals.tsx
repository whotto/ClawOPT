// 最高权限开关确认、系统口令输入弹窗。
import { Loader2, Zap } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';

export default function PermissionModals({ ctx }: { ctx: SettingsController }) {
  const {
    closeMaxPermissionsConfirmModal,
    closePermissionsPasswordModal,
    handleConfirmMaxPermissionsToggle,
    handleSubmitPermissionsPassword,
    hostTakeoverStatus,
    isSubmittingPermissionsPassword,
    isTogglingPermissions,
    maxPermissionsConfirmPendingEnabled,
    permissionsPassword,
    permissionsPasswordError,
    permissionsPasswordModalOpen,
    permissionsPasswordUser,
    setPermissionsPassword,
    t,
  } = ctx;

  return (
    <>
      {maxPermissionsConfirmPendingEnabled !== null && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
                {isTogglingPermissions
                  ? <Loader2 className="h-6 w-6 animate-spin text-amber-600" />
                  : <Zap className="h-6 w-6 text-amber-600" />}
              </div>
              <h3 className="mb-2 text-lg font-bold text-gray-900">
                {t(maxPermissionsConfirmPendingEnabled
                  ? 'settings.gateway.maxPermissionsRestartConfirmTitle'
                  : 'settings.gateway.maxPermissionsDisableRestartConfirmTitle')}
              </h3>
              <p className="text-sm text-gray-500 whitespace-pre-wrap">
                {t(maxPermissionsConfirmPendingEnabled
                  ? 'settings.gateway.maxPermissionsRestartConfirmMessage'
                  : 'settings.gateway.maxPermissionsDisableRestartConfirmMessage')}
              </p>
            </div>
            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={closeMaxPermissionsConfirmModal}
                disabled={isTogglingPermissions}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmMaxPermissionsToggle()}
                disabled={isTogglingPermissions}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isTogglingPermissions
                  ? t('settings.gateway.hostTakeoverPasswordSubmitting')
                  : t(maxPermissionsConfirmPendingEnabled
                    ? 'settings.gateway.maxPermissionsRestartConfirmAction'
                    : 'settings.gateway.maxPermissionsDisableRestartConfirmAction')}
              </button>
            </div>
          </div>
        </div>
      )}

      {permissionsPasswordModalOpen && (
        <div className="fixed inset-0 z-[230] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity" />
          <div className="relative z-10 w-full max-w-sm overflow-y-auto rounded-2xl border border-gray-200 bg-white max-h-[calc(100vh-2rem)] animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
                {isSubmittingPermissionsPassword
                  ? <Loader2 className="h-6 w-6 animate-spin text-amber-600" />
                  : <Zap className="h-6 w-6 text-amber-600" />}
              </div>
              <h3 className="mb-2 text-center text-lg font-bold text-gray-900">
                {t('settings.gateway.hostTakeoverPasswordModalTitle')}
              </h3>
              <p className="text-center text-sm text-gray-500 whitespace-pre-wrap">
                {t('settings.gateway.hostTakeoverPasswordModalMessage')}
              </p>

              <div className="mt-5 space-y-4">
                <div>
                  <div className="mb-2 text-sm font-semibold text-gray-900">
                    {t('settings.gateway.hostTakeoverCurrentUserLabel')}
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 font-mono text-sm text-gray-700 break-all">
                    {permissionsPasswordUser || hostTakeoverStatus?.currentUser || '-'}
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-gray-900">
                    {t('settings.gateway.hostTakeoverPasswordLabel')}
                  </label>
                  <input
                    type="password"
                    value={permissionsPassword}
                    onChange={(event) => setPermissionsPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !isSubmittingPermissionsPassword) {
                        event.preventDefault();
                        void handleSubmitPermissionsPassword();
                      }
                    }}
                    placeholder={t('settings.gateway.hostTakeoverPasswordPlaceholder')}
                    disabled={isSubmittingPermissionsPassword}
                    className="block w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
                  />
                </div>

                {permissionsPasswordError.message && (
                  <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-3 text-sm text-red-600">
                    <div>{permissionsPasswordError.message}</div>
                    {permissionsPasswordError.detail && (
                      <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                        {permissionsPasswordError.detail}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-3 border-t border-gray-100 bg-gray-50 p-4">
              <button
                type="button"
                onClick={closePermissionsPasswordModal}
                disabled={isSubmittingPermissionsPassword}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-4 py-2.5 font-semibold text-gray-700 transition-all hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitPermissionsPassword()}
                disabled={isSubmittingPermissionsPassword}
                className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 font-semibold text-white transition-all hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmittingPermissionsPassword
                  ? t('settings.gateway.hostTakeoverPasswordSubmitting')
                  : t('settings.gateway.hostTakeoverPasswordSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
