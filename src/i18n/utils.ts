import ko from "./ko.json";
import en from "./en.json";

export const languages = {
  ko: "한국어",
  en: "English",
} as const;

export type Locale = keyof typeof languages;

export const defaultLocale: Locale = "ko";

const translations = { ko, en } as const;

type TranslationKeys = typeof ko;

export function getLocaleFromUrl(url: URL): Locale {
  const [, lang] = url.pathname.split("/");
  if (lang in languages) {
    return lang as Locale;
  }
  return defaultLocale;
}

export function useTranslations(locale: Locale) {
  return function t<K extends keyof TranslationKeys>(
    key: K
  ): TranslationKeys[K] {
    return translations[locale][key] ?? translations[defaultLocale][key];
  };
}

// 중첩된 키 접근을 위한 헬퍼 함수
export function getNestedTranslation(
  locale: Locale,
  path: string
): string {
  const keys = path.split(".");
  let result: unknown = translations[locale];

  for (const key of keys) {
    if (result && typeof result === "object" && key in result) {
      result = (result as Record<string, unknown>)[key];
    } else {
      // fallback to default locale
      result = translations[defaultLocale];
      for (const k of keys) {
        if (result && typeof result === "object" && k in result) {
          result = (result as Record<string, unknown>)[k];
        } else {
          return path; // 번역을 찾지 못하면 키 반환
        }
      }
      break;
    }
  }

  return typeof result === "string" ? result : path;
}

// 언어 전환 URL 생성
export function getLocalizedUrl(url: URL, targetLocale: Locale): string {
  const currentLocale = getLocaleFromUrl(url);
  const pathname = url.pathname;

  if (currentLocale === defaultLocale) {
    // 현재 기본 언어(ko)인 경우
    if (targetLocale === defaultLocale) {
      return pathname;
    }
    // 다른 언어로 전환
    return `/${targetLocale}${pathname}`;
  } else {
    // 현재 다른 언어(en)인 경우
    const pathWithoutLocale = pathname.replace(`/${currentLocale}`, "") || "/";
    if (targetLocale === defaultLocale) {
      return pathWithoutLocale;
    }
    return `/${targetLocale}${pathWithoutLocale}`;
  }
}

// 간단한 t() 함수 - 컴포넌트에서 사용
export function t(locale: Locale, path: string): string {
  return getNestedTranslation(locale, path);
}
