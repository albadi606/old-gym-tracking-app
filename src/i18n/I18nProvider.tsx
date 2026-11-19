import { type ReactNode, useEffect, useMemo } from 'react';

import { I18nContext, type I18nContextValue } from './context.ts';
import { applyDocumentLocale, DEFAULT_LOCALE_CODE, resolveLocale } from './locales.ts';

export interface I18nProviderProps {
  localeCode?: string;
  children: ReactNode;
}

export function I18nProvider({
  localeCode = DEFAULT_LOCALE_CODE,
  children,
}: I18nProviderProps): ReactNode {
  const value = useMemo<I18nContextValue>(() => {
    const locale = resolveLocale(localeCode);
    return { locale, strings: locale.strings };
  }, [localeCode]);

  useEffect(() => {
    applyDocumentLocale(document, value.locale);
  }, [value.locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
