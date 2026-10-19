import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

type NestedCatalog = { [key: string]: string | NestedCatalog }

function flattenCatalog(catalog: NestedCatalog, prefix = ''): Map<string, string> {
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      entries.set(path, value)
    } else {
      for (const [nestedPath, nestedValue] of flattenCatalog(value, path)) {
        entries.set(nestedPath, nestedValue)
      }
    }
  }
  return entries
}

const variablesOf = (value: string | undefined): string[] => value?.match(/{{[^}]+}}/g) ?? []

describe('Session Info locale catalogs', () => {
  it.each([
    ['es', es],
    ['ja', ja],
    ['ko', ko],
    ['zh', zh]
  ])('%s has the same keys and interpolation variables as English', (_locale, catalog) => {
    const english = flattenCatalog(en)
    const localized = flattenCatalog(catalog)
    expect([...localized.keys()].sort()).toEqual([...english.keys()].sort())
    for (const [key, text] of english) {
      expect(variablesOf(localized.get(key))).toEqual(variablesOf(text))
    }
  })
})
