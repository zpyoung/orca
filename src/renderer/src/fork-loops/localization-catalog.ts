import railEN from './rail/locales/en.json'
import railES from './rail/locales/es.json'
import railFR from './rail/locales/fr.json'
import railJA from './rail/locales/ja.json'
import railKO from './rail/locales/ko.json'
import railZH from './rail/locales/zh.json'
import setupEN from './setup/locales/en.json'
import setupES from './setup/locales/es.json'
import setupFR from './setup/locales/fr.json'
import setupJA from './setup/locales/ja.json'
import setupKO from './setup/locales/ko.json'
import setupZH from './setup/locales/zh.json'
import statusEN from './status/locales/en.json'
import statusES from './status/locales/es.json'
import statusFR from './status/locales/fr.json'
import statusJA from './status/locales/ja.json'
import statusKO from './status/locales/ko.json'
import statusZH from './status/locales/zh.json'

function mergeNamespaces(
  setup: object,
  rail: object,
  status: object
): { fork: { loops: { setup: object; rail: object; status: object } } } {
  return { fork: { loops: { setup, rail, status } } }
}

/** Fork-owned catalogs consumed by the central fork localization registrar. */
export const loopsCatalogs = {
  en: mergeNamespaces(setupEN, railEN, statusEN),
  es: mergeNamespaces(setupES, railES, statusES),
  fr: mergeNamespaces(setupFR, railFR, statusFR),
  ja: mergeNamespaces(setupJA, railJA, statusJA),
  ko: mergeNamespaces(setupKO, railKO, statusKO),
  zh: mergeNamespaces(setupZH, railZH, statusZH)
} as const
