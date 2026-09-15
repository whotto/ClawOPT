// 通用设置：AI 名称、登录口令、界面语言、历史分页轮数、预览转换超时、诊断快照。
import { type ChangeEvent, useCallback, useState } from 'react';
import { getDiagnostics } from '../../../api/diagnostics';
import { persistChatHistoryPageRounds, readChatHistoryPageRounds } from '../../../utils/historyPagination';
import { normalizePreviewTimeoutSeconds, parsePreviewTimeoutSecondsInput } from '../shared/settingsHelpers';
import { saveConfig } from '../../../api/config';
import { applyLanguagePreference, normalizeLanguage, type SupportedLanguage } from '../../../i18n';
import type { useSettingsShared } from './useSettingsShared';

export function useGeneralSettings(deps: Pick<ReturnType<typeof useSettingsShared>, 'i18n' | 'setIsLoading' | 't'>) {
  const { i18n, setIsLoading, t } = deps;

  // 诊断快照：一键取回现场。这个产品装在用户自己的主机上，我们看不见——
  // 此前排障能拿到的只有一句截图或者一次 SSH。
  const [diagnosticsState, setDiagnosticsState] = useState<'idle' | 'working' | 'copied' | 'failed'>('idle');

  const handleCopyDiagnostics = useCallback(async () => {
    setDiagnosticsState('working');
    try {
      const res = await getDiagnostics();
      if (!res.ok) throw new Error(String(res.status));
      const text = JSON.stringify(await res.json(), null, 2);

      // ClawOPT 常以 http 跑在内网 IP 上，而 navigator.clipboard 要求安全上下文，
      // 在那种部署下它**根本不存在**。所以必须留一条不依赖它的退路，
      // 否则这个按钮会在最需要它的那批机器上静默失效。
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      setDiagnosticsState('copied');
    } catch {
      setDiagnosticsState('failed');
    }
    window.setTimeout(() => setDiagnosticsState('idle'), 2400);
  }, []);

  // --- General settings state ---
  const [aiName, setAiName] = useState(() => t('settings.general.aiNamePlaceholder'));
  const [loginEnabled, setLoginEnabled] = useState(false);
  // 起手为空：空串在后端表示「不修改」。没有默认口令。
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [generalSaved, setGeneralSaved] = useState(false);
  const [generalError, setGeneralError] = useState(false);
  const [aiNameError, setAiNameError] = useState<'' | 'required' | 'tooLong'>('');
  const [historyPageRoundsInput, setHistoryPageRoundsInput] = useState(() => String(readChatHistoryPageRounds()));
  const [previewTimeoutSecondsInput, setPreviewTimeoutSecondsInput] = useState(() => String(normalizePreviewTimeoutSeconds(undefined)));
  const [previewTimeoutError, setPreviewTimeoutError] = useState(false);

  const getVisualLength = (str: string) => {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 127) len += 2;
      else len += 1;
    }
    return len;
  };

  const handleSaveGeneral = async () => {
    setIsLoading(true);
    setGeneralError(false);
    const nextHistoryPageRounds = commitHistoryPageRounds();
    if (!aiName.trim()) {
      setAiNameError('required');
      setIsLoading(false);
      return;
    }
    if (getVisualLength(aiName) > 20) {
      setAiNameError('tooLong');
      setIsLoading(false);
      return;
    }
    setAiNameError('');
    const nextPreviewTimeoutSeconds = parsePreviewTimeoutSecondsInput(previewTimeoutSecondsInput);
    if (nextPreviewTimeoutSeconds === null) {
      setPreviewTimeoutError(true);
      setIsLoading(false);
      return;
    }
    setPreviewTimeoutError(false);

    try {
      const res = await saveConfig({
          aiName,
          loginEnabled,
          loginPassword,
          historyPageRounds: nextHistoryPageRounds,
          previewConversionTimeoutSeconds: nextPreviewTimeoutSeconds,
        });
      if (res.ok) {
        setPreviewTimeoutSecondsInput(String(nextPreviewTimeoutSeconds));
        setGeneralSaved(true);
        setTimeout(() => setGeneralSaved(false), 2000);
      } else throw new Error(t('settings.general.saveError'));
    } catch (err) {
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLanguageChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextLanguage = normalizeLanguage(event.target.value) as SupportedLanguage;

    if (normalizeLanguage(i18n.resolvedLanguage || i18n.language) === nextLanguage) {
      return;
    }

    try {
      const response = await saveConfig({ language: nextLanguage });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data?.success === false) {
        throw new Error(
          (typeof data?.error === 'string' && data.error.trim()) ||
          (typeof data?.message === 'string' && data.message.trim()) ||
          'Failed to persist preferred language'
        );
      }

      await applyLanguagePreference(nextLanguage);
    } catch (error) {
      console.error('Failed to update language preference:', error);
      setGeneralError(true);
      setTimeout(() => setGeneralError(false), 3000);
    }
  };

  const commitHistoryPageRounds = () => {
    const nextValue = persistChatHistoryPageRounds(historyPageRoundsInput);
    setHistoryPageRoundsInput(String(nextValue));
    return nextValue;
  };

  const handleHistoryPageRoundsChange = (event: ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/[^\d]/g, '');
    setHistoryPageRoundsInput(digitsOnly);
  };

  const currentLanguage = normalizeLanguage(i18n.resolvedLanguage || i18n.language);

  return {
    diagnosticsState,
    setDiagnosticsState,
    handleCopyDiagnostics,
    aiName,
    setAiName,
    loginEnabled,
    setLoginEnabled,
    loginPassword,
    setLoginPassword,
    showLoginPassword,
    setShowLoginPassword,
    generalSaved,
    setGeneralSaved,
    generalError,
    setGeneralError,
    aiNameError,
    setAiNameError,
    historyPageRoundsInput,
    setHistoryPageRoundsInput,
    previewTimeoutSecondsInput,
    setPreviewTimeoutSecondsInput,
    previewTimeoutError,
    setPreviewTimeoutError,
    getVisualLength,
    handleSaveGeneral,
    handleLanguageChange,
    commitHistoryPageRounds,
    handleHistoryPageRoundsChange,
    currentLanguage,
  };
}
