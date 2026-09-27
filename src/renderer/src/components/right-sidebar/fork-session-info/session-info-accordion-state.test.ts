import { describe, expect, it } from 'vitest'
import { parseStoredSessionInfoSections } from './session-info-accordion-state'

describe('parseStoredSessionInfoSections', () => {
  it('opens Live activity when no preference exists', () => {
    expect(parseStoredSessionInfoSections(null)).toEqual(['live'])
  })

  it('preserves a deliberately fully-collapsed preference', () => {
    expect(parseStoredSessionInfoSections('[]')).toEqual([])
  })

  it('drops unknown and duplicate section ids', () => {
    expect(parseStoredSessionInfoSections('["context","missing","context","identity"]')).toEqual([
      'context',
      'identity'
    ])
  })

  it('uses the default for malformed storage', () => {
    expect(parseStoredSessionInfoSections('{')).toEqual(['live'])
  })
})
