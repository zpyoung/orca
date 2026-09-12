import i18next from 'i18next'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../fork-hosted-review-sitter/localization-catalog', () => ({
  hostedReviewSitterCatalogs: {
    en: {
      'fork.hostedReviewSitter.fixture.immediate': 'sitter English',
      'fork.hostedReviewSitter.fixture.override': 'sitter English override'
    },
    es: {
      'fork.hostedReviewSitter.fixture.lazy': 'sitter Spanish',
      'fork.hostedReviewSitter.fixture.override': 'sitter Spanish override'
    },
    ja: {},
    ko: {},
    zh: {}
  }
}))

import { registerForkLocalizationCatalogs } from './fork-localization-catalogs'

describe('registerForkLocalizationCatalogs', () => {
  it('merges immediate and lazy fork catalogs without replacing unrelated resources', async () => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'en',
      fallbackLng: false,
      resources: {
        en: {
          translation: {
            'consumer.existing': 'existing English',
            'fork.hostedReviewSitter.fixture.override': 'upstream English'
          }
        },
        es: {
          translation: {
            'consumer.existing': 'existing Spanish',
            'fork.hostedReviewSitter.fixture.override': 'upstream Spanish'
          }
        }
      }
    })

    registerForkLocalizationCatalogs(instance)

    expect(instance.t('fork.hostedReviewSitter.fixture.immediate')).toBe('sitter English')
    expect(instance.t('fork.hostedReviewSitter.fixture.override')).toBe('sitter English override')
    expect(instance.t('consumer.existing')).toBe('existing English')

    await instance.changeLanguage('es')
    instance.emit('loaded', { es: { translation: true } })

    expect(instance.t('fork.hostedReviewSitter.fixture.lazy')).toBe('sitter Spanish')
    expect(instance.t('fork.hostedReviewSitter.fixture.override')).toBe('sitter Spanish override')
    expect(instance.t('consumer.existing')).toBe('existing Spanish')
  })
})
