import { describe, expect, it } from 'vitest'
import { toAgentLaunchPreferencesWithOptionValues } from './agent-launch-preferences-with-option-values'

describe('negotiated agent launch preference values', () => {
  it('includes non-legacy launch values only when negotiated', () => {
    expect(
      toAgentLaunchPreferencesWithOptionValues(
        { model: 'gpt-5', effort: 'high', thinking: true, fastMode: false },
        { includeOptionValues: true }
      )
    ).toEqual({
      model: 'gpt-5',
      effort: 'high',
      optionValues: { thinking: true, fastMode: false }
    })
    expect(
      toAgentLaunchPreferencesWithOptionValues({ model: 'gpt-5' }, { includeOptionValues: true })
    ).toEqual({
      model: 'gpt-5',
      optionValues: {}
    })
    expect(
      toAgentLaunchPreferencesWithOptionValues(undefined, { includeOptionValues: true })
    ).toEqual({
      optionValues: {}
    })
  })
})
