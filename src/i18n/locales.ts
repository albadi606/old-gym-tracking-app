import { type AppStrings, en } from './en.ts';

export type TextDirection = 'ltr' | 'rtl';

export interface LocaleDescriptor {
  code: string;
  /** Endonym, shown in a future language picker. */
  name: string;
  dir: TextDirection;
  strings: AppStrings;
}

/**
 * Only English ships today. Arabic is not translated and is deliberately not listed:
 * an empty or machine-translated locale would be worse than an honest single language.
 * Adding it later means adding one entry here plus one `ar.ts` typed as `AppStrings`.
 */
export const LOCALES: Record<string, LocaleDescriptor> = {
  en: { code: 'en', name: 'English', dir: 'ltr', strings: en },
};

export const DEFAULT_LOCALE_CODE = 'en';

export function resolveLocale(code: string = DEFAULT_LOCALE_CODE): LocaleDescriptor {
  return LOCALES[code] ?? LOCALES[DEFAULT_LOCALE_CODE]!;
}

/**
 * Applies language and writing direction at the document boundary, so a right-to-left
 * locale flips the whole layout without any component knowing about direction.
 */
export function applyDocumentLocale(documentRef: Document, locale: LocaleDescriptor): void {
  documentRef.documentElement.lang = locale.code;
  documentRef.documentElement.dir = locale.dir;
}
