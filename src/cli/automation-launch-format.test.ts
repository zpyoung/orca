import { describe, expect, it } from 'vitest'
import { formatAutomationLaunchOverrides } from './automation-launch-format'

describe('formatAutomationLaunchOverrides', () => {
  it('formats catalog labels and raw arguments', () => {
    expect(
      formatAutomationLaunchOverrides({
        agentId: 'claude',
        launchOverrides: {
          model: 'sonnet',
          optionValues: { effort: 'high' },
          agentArgs: '--verbose'
        }
      } as never)
    ).toBe('claude · Sonnet · Effort: high · --verbose')
  })

  it('omits launch output when the override is empty', () => {
    expect(
      formatAutomationLaunchOverrides({ agentId: 'codex', launchOverrides: null } as never)
    ).toBeNull()
  })
})
