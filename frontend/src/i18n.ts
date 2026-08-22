import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

export const LANGUAGE_STORAGE_KEY = 'clawopt_preferred_language';
export const SUPPORTED_LANGUAGES = ['zh-CN', 'zh-TW', 'en'] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function normalizeLanguage(input?: string | null): SupportedLanguage {
  const normalized = (input || '').trim().toLowerCase().replace(/_/g, '-');

  if (
    normalized === 'zh-cn' ||
    normalized === 'zh-sg' ||
    normalized === 'zh-hans' ||
    normalized.startsWith('zh-cn-') ||
    normalized.startsWith('zh-sg-') ||
    normalized.startsWith('zh-hans-')
  ) {
    return 'zh-CN';
  }

  if (
    normalized === 'zh-tw' ||
    normalized === 'zh-hk' ||
    normalized === 'zh-mo' ||
    normalized === 'zh-hant' ||
    normalized.startsWith('zh-tw-') ||
    normalized.startsWith('zh-hk-') ||
    normalized.startsWith('zh-mo-') ||
    normalized.startsWith('zh-hant-')
  ) {
    return 'zh-TW';
  }

  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en';
  }

  return 'en';
}

function syncDocumentLanguage(language?: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = normalizeLanguage(language);
}

function cacheLanguagePreference(language: SupportedLanguage) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch (error) {
    console.error('Failed to persist preferred language locally:', error);
  }
}

export async function applyLanguagePreference(language?: string | null): Promise<SupportedLanguage> {
  const normalized = normalizeLanguage(language);
  cacheLanguagePreference(normalized);

  if (normalizeLanguage(i18n.resolvedLanguage || i18n.language) === normalized) {
    syncDocumentLanguage(normalized);
    return normalized;
  }

  await i18n.changeLanguage(normalized);
  return normalized;
}

export async function syncLanguageFromConfig(): Promise<SupportedLanguage | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return null;
  }

  try {
    const response = await fetch('/api/config');
    if (!response.ok) {
      return null;
    }

    const data = await response.json().catch(() => ({}));
    if (typeof data?.language !== 'string' || !data.language.trim()) {
      return null;
    }

    return applyLanguagePreference(data.language);
  } catch {
    return null;
  }
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      en: { translation: en },
    },
    supportedLngs: [...SUPPORTED_LANGUAGES],
    fallbackLng: 'en',
    load: 'currentOnly',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: [],
      convertDetectedLanguage: normalizeLanguage,
    },
  })
  .then(async () => {
    syncDocumentLanguage(i18n.resolvedLanguage || i18n.language);
    await syncLanguageFromConfig();
  });

i18n.on('languageChanged', (language) => {
  syncDocumentLanguage(language);
});

export default i18n;
