import { describe, expect, it } from 'vitest'
import { formatAutomationLaunchOverrides } from './automation-launch-format'

describe('formatAutomationLaunchOverrides', () => {
  it('formats catalog labels without a retired raw-arguments field', () => {
    expect(
      formatAutomationLaunchOverrides({
        agentId: 'claude',
        launchOverrides: {
          model: 'sonnet',
          optionValues: { effort: 'high' },
          ...{ agentArgs: '--verbose' }
        }
      })
    ).toBe('claude · Sonnet · Effort: high')
  })

  it('omits launch output when the override is empty', () => {
    expect(formatAutomationLaunchOverrides({ agentId: 'codex', launchOverrides: null })).toBeNull()
  })
})
