import { describe, expect, it } from 'vitest'
import {
  buildAutomationLaunchOverridesCreateFields,
  buildAutomationLaunchOverridesUpdateFields
} from './automation-launch-overrides-save'

describe('automation launch override save fields', () => {
  it('normalizes configured values for creates and updates', () => {
    const value = { model: ' opus ', agentArgs: ' --verbose ' }
    expect(buildAutomationLaunchOverridesCreateFields(value, 'supported')).toEqual({
      launchOverrides: { model: 'opus', agentArgs: ' --verbose ' }
    })
    expect(buildAutomationLaunchOverridesUpdateFields(value, 'supported')).toEqual({
      launchOverrides: { model: 'opus', agentArgs: ' --verbose ' }
    })
  })

  it('omits empty create values and clears empty update values', () => {
    expect(buildAutomationLaunchOverridesCreateFields({}, 'supported')).toEqual({})
    expect(buildAutomationLaunchOverridesUpdateFields({}, 'supported')).toEqual({
      launchOverrides: null
    })
  })

  it.each(['pending', 'unsupported'] as const)(
    'omits the field entirely while the host gate is %s',
    (gate) => {
      const value = { model: 'opus' }
      const created = buildAutomationLaunchOverridesCreateFields(value, gate)
      const updated = buildAutomationLaunchOverridesUpdateFields(value, gate)
      expect(Object.hasOwn(created, 'launchOverrides')).toBe(false)
      expect(Object.hasOwn(updated, 'launchOverrides')).toBe(false)
    }
  )
})
