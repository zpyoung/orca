import { describe, expect, it } from 'vitest'

import { readApprovalFullInputFields } from './approval-full-input-envelope'

describe('readApprovalFullInputFields', () => {
  it('reads the untruncated input, its field name, and its length', () => {
    expect(
      readApprovalFullInputFields({ full: 'git status -sb', fullField: 'command', fullLength: 14 })
    ).toEqual({ full: 'git status -sb', fullField: 'command', fullLength: 14 })
  })

  it('keeps the declared length when the relay compacted the text below it', () => {
    expect(
      readApprovalFullInputFields({ full: 'git st', fullField: 'command', fullLength: 4000 })
    ).toEqual({ full: 'git st', fullField: 'command', fullLength: 4000 })
  })

  it('yields nothing for a host that predates the field', () => {
    expect(readApprovalFullInputFields({ tool: 'Bash', summary: 'git status' })).toEqual({})
  })

  it('falls back to the text length when the declared one is absent or nonsensical', () => {
    expect(readApprovalFullInputFields({ full: 'git status' })).toEqual({
      full: 'git status',
      fullLength: 10
    })
    // shorter than what arrived, so it cannot be describing this text
    expect(readApprovalFullInputFields({ full: 'git status', fullLength: 4 })).toEqual({
      full: 'git status',
      fullLength: 10
    })
    expect(readApprovalFullInputFields({ full: 'git status', fullLength: '900' })).toEqual({
      full: 'git status',
      fullLength: 10
    })
  })

  it('keeps the input when the field name is missing or unusable', () => {
    expect(readApprovalFullInputFields({ full: 'git status', fullField: 7 })).toEqual({
      full: 'git status',
      fullLength: 10
    })
  })

  it('rejects a non-string or empty input', () => {
    expect(readApprovalFullInputFields({ full: 42 })).toEqual({})
    expect(readApprovalFullInputFields({ full: '' })).toEqual({})
  })
})
