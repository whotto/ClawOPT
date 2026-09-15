// 网关设置页签。
import { Activity, Check, Edit2, Eye, EyeOff, Link2, Loader2, Plus, Trash2, X } from 'lucide-react';
import type { SettingsController } from '../useSettingsController';
import GatewayServiceCard from './GatewayServiceCard';

export default function GatewayTab({ ctx }: { ctx: SettingsController }) {
  const {
    allowedHosts,
    browserHeadedModeEnabled,
    browserHeadedModeModalStage,
    browserHealthDetailText,
    browserHealthError,
    browserHealthFacts,
    browserHealthNotice,
    canRestartGateway,
    canSaveGateway,
    detectError,
    detectGatewayConfig,
    devicePairingMode,
    devicePairingStatus,
    devicePairingToneClass,
    editHostValue,
    editingHost,
    gatewayError,
    gatewayRestartModalStage,
    gatewayRestartNoticeSource,
    gatewaySaved,
    handleAddHost,
    handleApproveLatestDevicePairing,
    handleCheckBrowserHealth,
    handleRemoveHost,
    handleRestartGateway,
    handleSave,
    handleSelfHealBrowser,
    handleTest,
    handleToggleBrowserHeadedMode,
    handleToggleMaxPermissions,
    handleUpdateHost,
    hasPassword,
    hasToken,
    hostTakeoverManualInstallVisible,
    hostTakeoverMode,
    hostTakeoverPathVisible,
    hostTakeoverStatus,
    hostTakeoverToneClass,
    isApprovingDevicePairing,
    isDetectingAll,
    isGatewayLoading,
    isLoadingBrowserHeadedMode,
    isRestarting,
    isSubmittingPermissionsPassword,
    isTogglingBrowserHeadedMode,
    isTogglingPermissions,
    latestDevicePairing,
    latestDevicePairingRoleText,
    latestDevicePairingScopeText,
    maxPermissions,
    newHost,
    openClawCurrentVersion,
    password,
    permissionsError,
    permissionsNotice,
    renderBrowserTaskActionButton,
    restartSuccess,
    secondaryActionButtonClass,
    setEditHostValue,
    setEditingHost,
    setNewHost,
    setPassword,
    setShowPassword,
    setToken,
    setUrl,
    showPassword,
    startEditHost,
    t,
    testResult,
    token,
    updateRestartModalStage,
    url,
  } = ctx;

  return (
    <>
      <GatewayServiceCard />
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="flex min-w-0 items-baseline gap-3">
            <h3 className="text-lg font-semibold text-gray-900">
              {t('settings.gateway.connectionTitle')}
            </h3>
            {openClawCurrentVersion && (
              <span className="text-sm font-normal text-gray-500">
                {t('settings.gateway.versionInline', { version: openClawCurrentVersion })}
              </span>
            )}
          </div>
          <div className="flex min-w-0 justify-end">
            <button
              type="button"
              onClick={() => { void detectGatewayConfig(); }}
              disabled={isDetectingAll || isGatewayLoading}
              className={`${secondaryActionButtonClass} shrink-0`}
            >
              {isDetectingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
              {t('settings.gateway.autoDetect')}
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-500 mb-6 mt-1">{t('settings.gateway.description')}</p>
        {detectError ? (
          <p className="mb-4 text-sm text-red-600">{detectError}</p>
        ) : null}

        <div className="space-y-5 sm:space-y-6 bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
          <div>
            <label className="block text-sm font-semibold text-gray-900 mb-2">
              {t('settings.gateway.gatewayUrlLabel')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="ws://127.0.0.1:18789"
              className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.gateway.tokenLabel')}</label>
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={hasToken ? t('settings.gateway.secretConfigured') : ''}
              className="block w-full px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
            />
            {hasToken && <p className="text-xs text-gray-400 mt-1.5">{t('settings.gateway.secretKeepHint')}</p>}
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.gateway.passwordLabel')}</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                placeholder={hasPassword ? t('settings.gateway.secretConfigured') : ''}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Max Permissions Toggle */}
        <div className="mt-8">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.gateway.permissionsTitle')}</h3>
          <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.permissionsDescription')}</p>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200">
            <div className="flex items-center justify-between">
              <div className="flex-1 pr-4">
                <div className="text-sm font-semibold text-gray-900">{t('settings.gateway.maxPermissionsLabel')}</div>
                <p className="text-xs text-gray-400 mt-1">
                  {t('settings.gateway.maxPermissionsHint')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={maxPermissions}
                disabled={isTogglingPermissions}
                onClick={handleToggleMaxPermissions}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed ${ maxPermissions ? 'bg-blue-600' : 'bg-gray-200' }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${ maxPermissions ? 'translate-x-6' : 'translate-x-1' }`}
                />
              </button>
            </div>
            {gatewayRestartNoticeSource === 'permissions' && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                {t('settings.gateway.restartRequiredNotice')}
              </div>
            )}

            <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${hostTakeoverToneClass}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{t('settings.gateway.hostTakeoverStatusLabel')}</span>
                <span className="rounded-full border border-current/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
                  {t(`settings.gateway.hostTakeoverModes.${hostTakeoverMode}`)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-current">
                {t(`settings.gateway.hostTakeoverDescriptions.${hostTakeoverMode}`)}
              </p>
              {hostTakeoverStatus?.currentUser && (
                <p className="mt-3 text-xs text-gray-600">
                  <span className="font-semibold text-gray-700">{t('settings.gateway.hostTakeoverCurrentUserLabel')}:</span>{' '}
                  <span className="font-mono">{hostTakeoverStatus.currentUser}</span>
                </p>
              )}
              {hostTakeoverPathVisible && (
                <div className="mt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t('settings.gateway.hostTakeoverEntryPointLabel')}
                  </div>
                  <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 font-mono text-xs text-gray-700 break-all">
                    {hostTakeoverStatus?.hostRootPath}
                  </div>
                </div>
              )}
              {hostTakeoverStatus?.rawDetail && (
                <div className="mt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t('settings.gateway.hostTakeoverDetailLabel')}
                  </div>
                  <div className="mt-1 rounded-xl border border-current/10 bg-white/70 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                    {hostTakeoverStatus.rawDetail}
                  </div>
                </div>
              )}
              {hostTakeoverManualInstallVisible && (
                <div className="mt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t('settings.gateway.hostTakeoverManualInstallLabel')}
                  </div>
                  <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 font-mono text-xs text-gray-700 break-all whitespace-pre-wrap">
                    {hostTakeoverStatus?.manualInstallCommand}
                  </div>
                </div>
              )}
            </div>

            <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${devicePairingToneClass}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{t('settings.gateway.devicePairingStatusLabel')}</span>
                <span className="rounded-full border border-current/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
                  {t(`settings.gateway.devicePairingModes.${devicePairingMode}`)}
                </span>
              </div>
              <p className="mt-2 text-sm leading-6 text-current">
                {devicePairingMode === 'loading'
                  ? t('settings.gateway.devicePairingDescriptions.loading')
                  : devicePairingMode === 'pending'
                  ? t('settings.gateway.devicePairingDescriptions.pending', { count: devicePairingStatus?.pending.length || 0 })
                  : devicePairingMode === 'paired'
                    ? t('settings.gateway.devicePairingDescriptions.paired', { count: devicePairingStatus?.pairedCount || 0 })
                    : devicePairingMode === 'unavailable'
                      ? t('settings.gateway.devicePairingDescriptions.unavailable')
                      : t('settings.gateway.devicePairingDescriptions.idle')}
              </p>
              {latestDevicePairing && (
                <>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        {t('settings.gateway.devicePairingRequestLabel')}
                      </div>
                      <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 font-mono text-xs text-gray-700 break-all">
                        {latestDevicePairing.requestId}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        {t('settings.gateway.devicePairingDeviceLabel')}
                      </div>
                      <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-700 break-all">
                        {latestDevicePairing.displayName || latestDevicePairing.deviceId || t('common.unknown')}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        {t('settings.gateway.devicePairingRoleLabel')}
                      </div>
                      <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-700 break-all">
                        {latestDevicePairingRoleText}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                        {t('settings.gateway.devicePairingScopeLabel')}
                      </div>
                      <div className="mt-1 rounded-xl border border-gray-200 bg-white/80 px-3 py-2 text-xs text-gray-700 break-all whitespace-pre-wrap">
                        {latestDevicePairingScopeText || t('common.unknown')}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={handleApproveLatestDevicePairing}
                      disabled={isApprovingDevicePairing || isTogglingPermissions || isSubmittingPermissionsPassword}
                      className={secondaryActionButtonClass}
                    >
                      {isApprovingDevicePairing
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Link2 className="w-4 h-4" />}
                      {isApprovingDevicePairing
                        ? t('settings.gateway.devicePairingApprovingLatest')
                        : t('settings.gateway.devicePairingApproveLatest')}
                    </button>
                    {latestDevicePairing.remoteIp && (
                      <span className="text-xs text-gray-600">
                        {t('settings.gateway.devicePairingIpLabel')}: {latestDevicePairing.remoteIp}
                      </span>
                    )}
                  </div>
                </>
              )}
              {devicePairingStatus?.rawDetail && (
                <div className="mt-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t('settings.gateway.devicePairingDetailLabel')}
                  </div>
                  <div className="mt-1 rounded-xl border border-current/10 bg-white/70 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                    {devicePairingStatus.rawDetail}
                  </div>
                </div>
              )}
            </div>

            {permissionsNotice && (
              <div className={`mt-4 rounded-xl border px-3 py-2 text-sm ${permissionsNotice.tone === 'success' ? 'border-green-200 bg-green-50 text-green-700' : 'border-amber-200 bg-amber-50 text-amber-700'}`}>
                {permissionsNotice.message}
              </div>
            )}

            {permissionsError.message && (
              <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-3 py-3 text-sm text-red-600 flex items-start gap-2">
                <X className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div>{permissionsError.message}</div>
                  {permissionsError.detail && (
                    <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                      {permissionsError.detail}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-8">
          <div className="mb-1 flex items-center justify-between gap-4">
            <h3 className="text-lg font-semibold text-gray-900">{t('settings.gateway.browserHealthTitle')}</h3>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-sm font-medium text-gray-600 whitespace-nowrap">
                {t('settings.gateway.browserHeadedModeLabel')}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={browserHeadedModeEnabled === true}
                aria-label={t('settings.gateway.browserHeadedModeLabel')}
                disabled={isLoadingBrowserHeadedMode || isTogglingBrowserHeadedMode || isGatewayLoading || browserHeadedModeModalStage !== null || gatewayRestartModalStage === 'restarting' || updateRestartModalStage === 'restarting'}
                onClick={handleToggleBrowserHeadedMode}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:opacity-60 ${browserHeadedModeEnabled ? 'bg-blue-600' : 'bg-gray-200'}`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ease-in-out ${browserHeadedModeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
                />
              </button>
            </div>
          </div>
          <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.browserHealthDescription')}</p>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
            <div className="space-y-3">
              <div className="flex gap-2 flex-nowrap">
                {renderBrowserTaskActionButton(
                  'checking',
                  handleCheckBrowserHealth,
                  t('settings.gateway.checkBrowserHealth'),
                  'activity',
                )}
                {renderBrowserTaskActionButton(
                  'repairing',
                  handleSelfHealBrowser,
                  t('settings.gateway.selfHealBrowser'),
                  'wrench',
                )}
              </div>

              <p className="text-sm text-gray-500 whitespace-pre-wrap break-all">
                <span className="font-medium text-gray-600">{t('settings.gateway.browserHealthDetailLabel')}:</span>{' '}
                <span>{browserHealthDetailText}</span>
              </p>
            </div>

            {browserHealthNotice && (
              <div className={`p-3 rounded-xl border text-sm ${browserHealthNotice.tone === 'success' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                {browserHealthNotice.message}
              </div>
            )}

            {gatewayRestartNoticeSource === 'browser' && (
              <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-sm text-amber-700">
                {t('settings.gateway.restartRequiredNotice')}
              </div>
            )}

            {browserHealthError.message && (
              <div className="p-3 bg-red-50 text-red-600 text-sm rounded-xl border border-red-100 flex items-start gap-2">
                <X className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div>{browserHealthError.message}</div>
                  {browserHealthError.detail && (
                    <div className="mt-2 rounded-xl border border-red-100 bg-white/70 px-3 py-2 text-xs text-red-500 whitespace-pre-wrap break-all font-mono">
                      {browserHealthError.detail}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {browserHealthFacts.map((item) => (
                <div key={item.label} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{item.label}</div>
                  <div className="mt-1 text-sm text-gray-700 break-all">{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Domain Management Section */}
        <div className="mt-8">
          <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.gateway.domainManagementTitle')}</h3>
          <p className="text-sm text-gray-500 mb-4">{t('settings.gateway.domainManagementDescription')}</p>

          <div className="bg-white p-4 sm:p-6 rounded-2xl border border-gray-200 space-y-4">
            <div className="flex flex-row gap-3">
              <input
                type="text"
                value={newHost}
                onChange={(e) => setNewHost(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddHost()}
                placeholder={t('settings.gateway.hostPlaceholder')}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm font-mono"
              />
              <button
                onClick={handleAddHost}
                disabled={!newHost.trim()}
                className="px-6 py-2.5 rounded-xl bg-blue-600 text-white font-bold text-sm hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">{t('common.add')}</span>
              </button>
            </div>

            <div className="space-y-2 max-h-[200px] overflow-y-auto">
               {allowedHosts.map(host => (
                 <div key={host} className="flex w-full items-center justify-between gap-3 p-3 rounded-xl bg-gray-50 border border-gray-100 group">
                   {editingHost === host ? (
                     <>
                       <input
                         type="text"
                         value={editHostValue}
                         onChange={(e) => setEditHostValue(e.target.value)}
                         onKeyDown={(e) => e.key === 'Enter' && handleUpdateHost()}
                         autoFocus
                         className="min-w-0 flex-1 w-full text-sm font-mono text-gray-700 bg-transparent outline-none border-none p-0"
                       />
                       <div className="flex items-center gap-1 shrink-0">
                         <button
                           onClick={handleUpdateHost}
                           disabled={!editHostValue.trim()}
                           className="p-1 px-2 text-green-600 hover:bg-green-50 rounded-lg transition-all disabled:opacity-50"
                           title={t('common.save')}
                         >
                           <Check className="w-4 h-4" />
                         </button>
                         <button
                           onClick={() => { setEditingHost(null); setEditHostValue(''); }}
                           className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                           title={t('common.cancel')}
                         >
                           <X className="w-4 h-4" />
                         </button>
                       </div>
                     </>
                   ) : (
                     <>
                       <span className="min-w-0 flex-1 text-sm font-mono text-gray-700 break-all">{host}</span>
                       <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-all">
                         <button
                           onClick={() => startEditHost(host)}
                           className="p-1 px-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded-lg transition-all"
                           title={t('common.edit')}
                         >
                           <Edit2 className="w-4 h-4" />
                         </button>
                         <button
                           onClick={() => handleRemoveHost(host)}
                           className="p-1 px-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                           title={t('common.delete')}
                         >
                           <Trash2 className="w-4 h-4" />
                         </button>
                       </div>
                     </>
                   )}
                 </div>
               ))}
               {allowedHosts.length === 0 && (
                 <div className="text-center py-6 text-gray-400 text-sm italic">
                   {t('settings.gateway.noHosts')}
                 </div>
               )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-row items-center justify-between pt-4 gap-2 sm:gap-0">
          <button
            onClick={handleTest}
            disabled={isGatewayLoading}
            className="inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 border border-gray-200 text-sm font-medium rounded-xl text-gray-700 bg-white hover:bg-gray-50 transition-all disabled:opacity-50"
          >
            {isGatewayLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {testResult?.success ? <Check className="w-4 h-4 text-green-600" /> : testResult && !testResult.success ? <X className="w-4 h-4 text-red-500" /> : null}
            <span className={testResult?.success ? 'text-green-600 font-semibold' : testResult && !testResult.success ? 'text-red-500 font-semibold' : ''}>
              {isGatewayLoading ? '' : testResult?.success ? t('settings.gateway.connectionSuccess') : testResult && !testResult.success ? (testResult.message || t('settings.gateway.connectionFailed')) : <><span className="sm:hidden">{t('common.test')}</span><span className="hidden sm:inline">{t('settings.gateway.testConnection')}</span></>}
            </span>
          </button>

        <div className="flex gap-2 sm:gap-3 items-center">
          <button
            onClick={handleRestartGateway}
            disabled={!canRestartGateway}
            className={`inline-flex items-center gap-2 px-4 sm:px-5 py-2.5 text-sm font-medium rounded-xl transition-all ${ canRestartGateway ? 'text-orange-600 bg-orange-50 hover:bg-orange-100 border border-orange-200' : 'text-gray-400 bg-gray-100 border border-gray-200 cursor-not-allowed' }`}
          >
            {isRestarting ? <Loader2 className="w-4 h-4 animate-spin sm:block hidden" /> : <Loader2 className="w-4 h-4 sm:block hidden" />}
            {restartSuccess ? t('settings.gateway.restarted') : <><span className="sm:hidden">{t('common.restart')}</span><span className="hidden sm:inline">{t('settings.gateway.restartGateway')}</span></>}
          </button>

          <div className="h-6 w-px bg-gray-200 hidden sm:block"></div>
          {gatewayError && (
            <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
              <X className="w-4 h-4" /> {t('settings.gateway.saveError')}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!canSaveGateway}
            className={`inline-flex items-center gap-2 px-5 sm:px-8 py-2.5 text-sm font-medium rounded-xl text-white transition-all ${ !canSaveGateway ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700' }`}
          >
            {isGatewayLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : gatewaySaved ? <><Check className="w-4 h-4" /> {t('settings.gateway.saved')}</> : <><span className="sm:hidden">{t('common.save')}</span><span className="hidden sm:inline">{t('settings.gateway.save')}</span></>}
          </button>
        </div>
      </div>
    </>
  );
}
