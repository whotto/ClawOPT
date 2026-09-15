// 通用设置页签。
import { Check, ChevronDown, Eye, EyeOff, Loader2, X } from 'lucide-react';
import NotificationSettingsSection from '../../../features/notifications/NotificationSettingsSection';
import type { SettingsController } from '../useSettingsController';
import { parsePreviewTimeoutSecondsInput, PREVIEW_TIMEOUT_MAX_SECONDS, PREVIEW_TIMEOUT_MIN_SECONDS } from '../shared/settingsHelpers';

export default function GeneralTab({ ctx }: { ctx: SettingsController }) {
  const {
    aiName,
    aiNameError,
    chatStreamTransport,
    commitHistoryPageRounds,
    currentLanguage,
    generalError,
    generalSaved,
    handleChatStreamTransportChange,
    handleHistoryPageRoundsChange,
    handleLanguageChange,
    handleSaveGeneral,
    hasLoginPassword,
    historyPageRoundsInput,
    isGeneralLoading,
    loginEnabled,
    loginPassword,
    previewTimeoutError,
    previewTimeoutSecondsInput,
    setAiName,
    setAiNameError,
    setLoginEnabled,
    setLoginPassword,
    setPreviewTimeoutError,
    setPreviewTimeoutSecondsInput,
    setShowLoginPassword,
    showLoginPassword,
    t,
  } = ctx;

  return (
    <>
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">{t('settings.general.title')}</h3>
        <p className="text-sm text-gray-500 mb-6">{t('settings.general.description')}</p>

        <div className="space-y-6 bg-white p-6 rounded-2xl border border-gray-200">
          {/* AI Name */}
          <div>
            <label className="block text-sm font-semibold text-gray-900 mb-2">
              {t('settings.general.aiNameLabel')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={aiName}
              onChange={(e) => {
                setAiName(e.target.value);
                if (aiNameError) setAiNameError('');
              }}
              placeholder={t('settings.general.aiNamePlaceholder')}
              className={`block w-full px-4 py-2.5 rounded-xl border ${aiNameError ? 'border-red-500' : 'border-gray-200'} bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 ${aiNameError ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all text-sm`}
            />
            {aiNameError ? (
              <p className="text-xs text-red-500 mt-1.5 font-medium">
                {aiNameError === 'required' ? t('settings.general.aiNameRequired') : t('settings.general.aiNameTooLong')}
              </p>
            ) : (
              <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.aiNameHint')}</p>
            )}
          </div>

          {/* Language */}
          <div className="border-t border-gray-100 pt-6">
            <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.languageLabel')}</label>
            <div className="relative">
              <select
                value={currentLanguage}
                onChange={handleLanguageChange}
                className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
              >
                <option value="zh-CN">{t('settings.general.languageOptions.zh-CN')}</option>
                <option value="zh-TW">{t('settings.general.languageOptions.zh-TW')}</option>
                <option value="en">{t('settings.general.languageOptions.en')}</option>
              </select>
              <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
                <ChevronDown className="w-4 h-4" />
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.languageHint')}</p>
          </div>

          <div className="border-t border-gray-100 pt-6">
            <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.historyPageRoundsLabel')}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={historyPageRoundsInput}
              onChange={handleHistoryPageRoundsChange}
              onBlur={commitHistoryPageRounds}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitHistoryPageRounds();
                  (event.currentTarget as HTMLInputElement).blur();
                }
              }}
              placeholder={t('settings.general.historyPageRoundsPlaceholder')}
              className="block w-full max-w-[220px] px-4 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
            />
            <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.historyPageRoundsHint')}</p>
          </div>

          <div className="border-t border-gray-100 pt-6">
            <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.chatStreamTransportLabel')}</label>
            <div className="relative max-w-[320px]">
              <select
                value={chatStreamTransport}
                onChange={handleChatStreamTransportChange}
                className="block w-full appearance-none px-4 pr-14 py-2.5 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
              >
                <option value="sse">{t('settings.general.chatStreamTransportOptions.sse')}</option>
                <option value="ws">{t('settings.general.chatStreamTransportOptions.ws')}</option>
              </select>
              <span className="pointer-events-none absolute inset-y-0 right-5 flex items-center text-gray-500">
                <ChevronDown className="w-4 h-4" />
              </span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">{t('settings.general.chatStreamTransportHint')}</p>
          </div>

          <NotificationSettingsSection />

          <div className="border-t border-gray-100 pt-6">
            <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.previewTimeoutLabel')}</label>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={previewTimeoutSecondsInput}
              onChange={(event) => {
                setPreviewTimeoutSecondsInput(event.target.value);
                if (previewTimeoutError) {
                  setPreviewTimeoutError(false);
                }
              }}
              onBlur={() => {
                const parsed = parsePreviewTimeoutSecondsInput(previewTimeoutSecondsInput);
                if (parsed !== null) {
                  setPreviewTimeoutSecondsInput(String(parsed));
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const parsed = parsePreviewTimeoutSecondsInput(previewTimeoutSecondsInput);
                  if (parsed !== null) {
                    setPreviewTimeoutSecondsInput(String(parsed));
                  }
                  (event.currentTarget as HTMLInputElement).blur();
                }
              }}
              placeholder={t('settings.general.previewTimeoutPlaceholder')}
              className={`block w-full max-w-[220px] px-4 py-2.5 rounded-xl border ${previewTimeoutError ? 'border-red-500' : 'border-gray-200'} bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 ${previewTimeoutError ? 'focus:ring-red-500/20' : 'focus:ring-blue-500/20'} transition-all text-sm`}
            />
            {previewTimeoutError ? (
              <p className="text-xs text-red-500 mt-1.5 font-medium">
                {t('settings.general.previewTimeoutInvalid', {
                  min: PREVIEW_TIMEOUT_MIN_SECONDS,
                  max: PREVIEW_TIMEOUT_MAX_SECONDS,
                })}
              </p>
            ) : (
              <p className="text-xs text-gray-400 mt-1.5">
                {t('settings.general.previewTimeoutHint', {
                  min: PREVIEW_TIMEOUT_MIN_SECONDS,
                  max: PREVIEW_TIMEOUT_MAX_SECONDS,
                })}
              </p>
            )}
          </div>

          {/* Login Password Toggle */}
          <div className="border-t border-gray-100 pt-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <label className="block text-sm font-semibold text-gray-900">{t('settings.general.loginProtectionLabel')}</label>
                <p className="text-xs text-gray-400 mt-0.5">{t('settings.general.loginProtectionHint')}</p>
              </div>
              <button
                type="button"
                onClick={() => setLoginEnabled(!loginEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${ loginEnabled ? 'bg-blue-600' : 'bg-gray-300' }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${ loginEnabled ? 'translate-x-6' : 'translate-x-1' }`}
                />
              </button>
            </div>

            {loginEnabled && (
              <div className="mt-3 animate-in slide-in-from-top-2 duration-200">
                <label className="block text-sm font-semibold text-gray-900 mb-2">{t('settings.general.loginPasswordLabel')}</label>
                <div className="relative">
                  <input
                    type={showLoginPassword ? "text" : "password"}
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder={hasLoginPassword ? t('settings.gateway.secretConfigured') : t('settings.general.loginPasswordPlaceholder')}
                    className="block w-full px-4 py-2.5 pr-12 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword(!showLoginPassword)}
                    className="absolute inset-y-0 right-0 px-4 flex items-center text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1.5">
                  {hasLoginPassword ? t('settings.gateway.secretKeepHint') : t('settings.general.loginPasswordHint')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center sm:justify-end pt-4">
        <div className="flex items-center gap-3 w-full sm:w-auto">
          {generalError && (
            <span className="text-sm font-semibold text-red-500 animate-in fade-in zoom-in-95 duration-200 flex items-center gap-1">
              <X className="w-4 h-4" /> {t('settings.general.saveError')}
            </span>
          )}
          <button
            onClick={handleSaveGeneral}
            disabled={isGeneralLoading}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-8 py-2.5 text-sm font-medium rounded-xl text-white bg-blue-600 hover:bg-blue-700 transition-all disabled:opacity-50"
          >
            {isGeneralLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : generalSaved ? <><Check className="w-4 h-4" /> {t('settings.general.saved')}</> : t('settings.general.save')}
          </button>
        </div>
      </div>
    </>
  );
}
