import { describe, it, expect, vi } from 'vitest'

// The label helper is translate()-backed; stub the catalog so these stay pure
// unit tests and assert on the English fallbacks rather than i18n wiring.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const {
  DEFAULT_NATIVE_CHAT_WIDTH_TIER,
  NATIVE_CHAT_WIDTH_TIERS,
  nativeChatWidthClassName,
  nativeChatWidthTierLabel,
  resolveNativeChatWidthTier
} = await import('./native-chat-width')

describe('NATIVE_CHAT_WIDTH_TIERS', () => {
  it('is ordered narrow to full so both controls list tiers identically', () => {
    expect(NATIVE_CHAT_WIDTH_TIERS).toEqual(['narrow', 'comfortable', 'wide', 'full'])
  })

  it('defaults to the comfortable tier', () => {
    expect(DEFAULT_NATIVE_CHAT_WIDTH_TIER).toBe('comfortable')
    expect(NATIVE_CHAT_WIDTH_TIERS).toContain(DEFAULT_NATIVE_CHAT_WIDTH_TIER)
  })
})

describe('nativeChatWidthClassName', () => {
  it('maps each tier to its Tailwind token', () => {
    expect(nativeChatWidthClassName('narrow')).toBe('max-w-2xl')
    expect(nativeChatWidthClassName('comfortable')).toBe('max-w-4xl')
    expect(nativeChatWidthClassName('wide')).toBe('max-w-6xl')
    expect(nativeChatWidthClassName('full')).toBe('max-w-none')
  })

  it('returns a distinct class for every tier', () => {
    const classNames = NATIVE_CHAT_WIDTH_TIERS.map(nativeChatWidthClassName)
    expect(new Set(classNames).size).toBe(NATIVE_CHAT_WIDTH_TIERS.length)
  })

  it('keeps the comfortable tier on the width the view shipped with', () => {
    expect(nativeChatWidthClassName(DEFAULT_NATIVE_CHAT_WIDTH_TIER)).toBe('max-w-4xl')
  })
})

describe('resolveNativeChatWidthTier', () => {
  it('passes through every known tier', () => {
    for (const tier of NATIVE_CHAT_WIDTH_TIERS) {
      expect(resolveNativeChatWidthTier(tier)).toBe(tier)
    }
  })

  it('falls back to the default while settings are still null or absent', () => {
    expect(resolveNativeChatWidthTier(undefined)).toBe(DEFAULT_NATIVE_CHAT_WIDTH_TIER)
    expect(resolveNativeChatWidthTier(null)).toBe(DEFAULT_NATIVE_CHAT_WIDTH_TIER)
  })

  it('falls back to the default for a hand-edited or stale persisted value', () => {
    expect(resolveNativeChatWidthTier('extra-wide' as never)).toBe(DEFAULT_NATIVE_CHAT_WIDTH_TIER)
    expect(resolveNativeChatWidthTier('' as never)).toBe(DEFAULT_NATIVE_CHAT_WIDTH_TIER)
  })
})

describe('nativeChatWidthTierLabel', () => {
  it('gives every tier a distinct human label', () => {
    const labels = NATIVE_CHAT_WIDTH_TIERS.map(nativeChatWidthTierLabel)
    expect(labels).toEqual(['Narrow', 'Comfortable', 'Wide', 'Full'])
    expect(new Set(labels).size).toBe(NATIVE_CHAT_WIDTH_TIERS.length)
  })
})
