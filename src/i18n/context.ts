import { createContext, useContext } from 'react';

import type { AppStrings } from './en.ts';
import { type LocaleDescriptor, resolveLocale } from './locales.ts';

export interface I18nContextValue {
  locale: LocaleDescriptor;
  strings: AppStrings;
}

const fallbackLocale = resolveLocale();

export const I18nContext = createContext<I18nContextValue>({
  locale: fallbackLocale,
  strings: fallbackLocale.strings,
});

/** Every piece of user-visible copy is read through this hook. */
export function useStrings(): AppStrings {
  return useContext(I18nContext).strings;
}

export function useLocale(): LocaleDescriptor {
  return useContext(I18nContext).locale;
}
