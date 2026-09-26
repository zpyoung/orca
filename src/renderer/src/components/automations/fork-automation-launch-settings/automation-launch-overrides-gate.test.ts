import { describe, expect, it } from 'vitest'
import { resolveAutomationLaunchOverridesGate } from './automation-launch-overrides-gate'

describe('resolveAutomationLaunchOverridesGate', () => {
  it('supports local targets without a capability probe', () => {
    expect(resolveAutomationLaunchOverridesGate({ kind: 'local' }, false)).toBe('supported')
  })

  it('keeps remote targets pending until their capability is known', () => {
    expect(
      resolveAutomationLaunchOverridesGate({ kind: 'environment', environmentId: 'env-1' }, null)
    ).toBe('pending')
  })

  it('uses the remote capability verdict', () => {
    const target = { kind: 'environment' as const, environmentId: 'env-1' }
    expect(resolveAutomationLaunchOverridesGate(target, true)).toBe('supported')
    expect(resolveAutomationLaunchOverridesGate(target, false)).toBe('unsupported')
  })
})
