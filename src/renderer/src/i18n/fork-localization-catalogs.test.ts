import { describe, expect, it, vi } from 'vitest'

import { registerForkLocalizationCatalogs } from './fork-localization-catalogs'

describe('registerForkLocalizationCatalogs', () => {
  it('merges English immediately and a lazy locale when i18next loads it', () => {
    const addResourceBundle = vi.fn()
    let loaded: ((resources: Record<string, Record<string, unknown>>) => void) | undefined
    const i18n = {
      addResourceBundle,
      on: vi.fn(
        (
          _event: string,
          listener: (resources: Record<string, Record<string, unknown>>) => void
        ) => {
          loaded = listener
          return i18n
        }
      )
    }

    registerForkLocalizationCatalogs(i18n)

    expect(addResourceBundle).toHaveBeenCalledWith(
      'en',
      'translation',
      expect.objectContaining({ components: expect.any(Object) }),
      true,
      true
    )
    loaded?.({ es: { translation: true } })
    expect(addResourceBundle).toHaveBeenCalledWith(
      'es',
      'translation',
      expect.objectContaining({ components: expect.any(Object) }),
      true,
      true
    )
  })
})
