import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

describe('Session Info locale catalogs', () => {
  it.each([
    ['es', es],
    ['ja', ja],
    ['ko', ko],
    ['zh', zh]
  ])('%s has the same keys and interpolation variables as English', (_locale, catalog) => {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(catalog[key].match(/{{[^}]+}}/g) ?? []).toEqual(en[key].match(/{{[^}]+}}/g) ?? [])
    }
  })
})
