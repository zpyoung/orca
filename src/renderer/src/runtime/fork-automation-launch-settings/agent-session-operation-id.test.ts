import { describe, expect, it } from 'vitest'
import { toAgentLaunchPreferences } from '../agent-session-create-operation'

describe('negotiated agent launch preference values', () => {
  it('includes non-legacy launch values only when negotiated', () => {
    expect(
      toAgentLaunchPreferences(
        { model: 'gpt-5', effort: 'high', thinking: true, fastMode: false },
        { includeOptionValues: true }
      )
    ).toEqual({
      model: 'gpt-5',
      effort: 'high',
      optionValues: { thinking: true, fastMode: false }
    })
    expect(toAgentLaunchPreferences({ model: 'gpt-5' }, { includeOptionValues: true })).toEqual({
      model: 'gpt-5',
      optionValues: {}
    })
    expect(toAgentLaunchPreferences(undefined, { includeOptionValues: true })).toEqual({
      optionValues: {}
    })
  })
})
