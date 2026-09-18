import { describe, expect, it } from 'vitest'
import {
  ActionOutcomeSchema,
  ObjectiveFailureClassSchema,
  resolveByExpectedState
} from './effect-certainty'

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

describe('ObjectiveFailureClassSchema', () => {
  it('accepts exactly the three failure classes', () => {
    for (const value of ['infra', 'environment', 'criteria']) {
      expect(ObjectiveFailureClassSchema.safeParse(value).success).toBe(true)
    }
    expect(ObjectiveFailureClassSchema.safeParse('unknown-cause').success).toBe(false)
  })
})

describe('ActionOutcomeSchema failureClass', () => {
  it('carries an optional failure class without requiring one', () => {
    expect(
      ActionOutcomeSchema.safeParse({ effect: 'not-landed', failureClass: 'infra' }).success
    ).toBe(true)
    expect(ActionOutcomeSchema.safeParse({ effect: 'not-landed' }).success).toBe(true)
    expect(
      ActionOutcomeSchema.safeParse({ effect: 'not-landed', failureClass: 'bogus' }).success
    ).toBe(false)
  })
})
