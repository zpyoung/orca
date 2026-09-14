import { describe, expect, it } from 'vitest'
import { ActionOutcomeSchema, resolveByExpectedState } from './effect-certainty'

describe('resolveByExpectedState', () => {
  it('classifies the expected after-state as landed', () => {
    expect(resolveByExpectedState('after', 'before', 'after')).toBe('landed')
  })

  it('classifies the unchanged before-state as not landed', () => {
    expect(resolveByExpectedState('before', 'before', 'after')).toBe('not-landed')
  })

  it('keeps every third value indeterminate', () => {
    expect(resolveByExpectedState('someone-else-moved-it', 'before', 'after')).toBe('indeterminate')
  })

  it('does not accept process-liveness vocabulary as effect certainty', () => {
    expect(ActionOutcomeSchema.safeParse({ effect: 'unverifiable' }).success).toBe(false)
  })
})
