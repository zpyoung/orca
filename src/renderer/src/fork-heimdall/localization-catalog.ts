import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

/** Kernel-owned catalogs consumed by the central fork localization registrar. */
export const heimdallCatalogs = { en, es, fr, ja, ko, zh } as const
