import { describe, expect, it } from 'vitest'
import { formatAutomationLaunchOverrides } from './automation-launch-format'
import { legacyLaunchOverrides } from '../../shared/fork-automation-launch-settings/legacy-launch-overrides.test-support'

describe('formatAutomationLaunchOverrides', () => {
  it('formats catalog labels without a retired raw-arguments field', () => {
    expect(
      formatAutomationLaunchOverrides({
        agentId: 'claude',
        launchOverrides: legacyLaunchOverrides({
          model: 'sonnet',
          optionValues: { effort: 'high' },
          agentArgs: '--verbose'
        })
      })
    ).toBe('claude · Sonnet · Effort: high')
  })

  it('omits launch output when the override is empty', () => {
    expect(formatAutomationLaunchOverrides({ agentId: 'codex', launchOverrides: null })).toBeNull()
  })
})
