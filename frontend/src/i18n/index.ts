import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getLocales } from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';

import en from './locales/en.json';
import ar from './locales/ar.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import pt from './locales/pt.json';
import tr from './locales/tr.json';
import ru from './locales/ru.json';
import zh from './locales/zh.json';
import id from './locales/id.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';

const LANGUAGE_KEY = 'hypertrade_language';

export const RTL_LANGUAGES = ['ar', 'he'];

export const SUPPORTED_LANGUAGES = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', flag: '🇸🇦' },
  { code: 'zh', name: 'Chinese', nativeName: '中文', flag: '🇨🇳' },
  { code: 'en', name: 'English', nativeName: 'English', flag: '🇬🇧' },
  { code: 'fr', name: 'French', nativeName: 'Français', flag: '🇫🇷' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', flag: '🇮🇩' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', flag: '🇯🇵' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', flag: '🇰🇷' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', flag: '🇷🇺' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷' },
  // Temporarily hidden - needs translation review
  // { code: 'de', name: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
  // { code: 'he', name: 'Hebrew', nativeName: 'עברית', flag: '🇮🇱' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

const resources = {
  en: { translation: en },
  ar: { translation: ar },
  es: { translation: es },
  fr: { translation: fr },
  tr: { translation: tr },
  ru: { translation: ru },
  zh: { translation: zh },
  ja: { translation: ja },
  ko: { translation: ko },
  pt: { translation: pt },
  id: { translation: id },
};

/**
 * Get the device's preferred language, mapped to our supported languages.
 */
function getDeviceLanguage(): LanguageCode {
  try {
    const locales = getLocales();
    if (locales?.length > 0) {
      const deviceLang = locales[0].languageCode?.toLowerCase() ?? 'en';
      // Check if we support this language directly
      const supported = SUPPORTED_LANGUAGES.find((l) => l.code === deviceLang);
      if (supported) return supported.code;
      // Check 2-letter prefix (e.g., 'zh-Hans' -> 'zh')
      const prefix = deviceLang.split('-')[0];
      const prefixMatch = SUPPORTED_LANGUAGES.find((l) => l.code === prefix);
      if (prefixMatch) return prefixMatch.code;
    }
  } catch {
    // Ignore localization errors
  }
  return 'en';
}

/**
 * Apply RTL layout if needed. Must be called before the app renders.
 * DISABLED: RTL support is disabled - this function does nothing to prevent layout changes.
 */
export function applyRTL(languageCode: string): boolean {
  // RTL support disabled - do nothing, never change layout
  return false;
}

/**
 * Load saved language from AsyncStorage, or fall back to device language.
 */
export async function getSavedLanguage(): Promise<LanguageCode> {
  try {
    const saved = await AsyncStorage.getItem(LANGUAGE_KEY);
    if (saved && SUPPORTED_LANGUAGES.some((l) => l.code === saved)) {
      return saved as LanguageCode;
    }
  } catch {
    // Ignore storage errors
  }
  return getDeviceLanguage();
}

/**
 * Save language preference to AsyncStorage.
 */
export async function saveLanguage(code: LanguageCode): Promise<void> {
  try {
    await AsyncStorage.setItem(LANGUAGE_KEY, code);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Change the app language. Returns true if app restart is needed (for RTL changes on native).
 */
export async function changeLanguage(code: LanguageCode): Promise<boolean> {
  await saveLanguage(code);
  await i18n.changeLanguage(code);
  // Apply RTL changes - returns true if restart needed
  return applyRTL(code);
}

// Initialize i18n
i18n.use(initReactI18next).init({
  resources,
  lng: getDeviceLanguage(), // Will be overridden by saved preference in _layout
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  react: {
    useSuspense: false, // Avoid suspense on React Native
  },
});

// RTL support disabled - no automatic RTL application on language changes

export default i18n;
