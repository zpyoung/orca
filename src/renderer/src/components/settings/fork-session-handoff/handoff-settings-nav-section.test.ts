import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))

import { getForkSessionHandoffNavSections } from './handoff-settings-nav-section'

describe('getForkSessionHandoffNavSections', () => {
  it('registers a searchable workflow target', () => {
    const [section] = getForkSessionHandoffNavSections()

    expect(section).toMatchObject({
      id: 'session-handoff',
      title: 'Session handoff',
      group: 'workflows'
    })
    expect(section?.searchEntries[0]).toMatchObject({
      title: 'Session handoff'
    })
    expect(section?.searchEntries[0]?.keywords).toEqual(
      expect.arrayContaining(['handoff', 'template', 'instructions'])
    )
  })
})
