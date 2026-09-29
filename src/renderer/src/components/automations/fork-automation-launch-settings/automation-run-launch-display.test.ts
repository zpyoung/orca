import { describe, expect, it } from 'vitest'
import { formatAutomationRunLaunchSettings } from './automation-run-launch-display'

describe('formatAutomationRunLaunchSettings', () => {
  it('formats catalog labels and keeps raw arguments separate', () => {
    expect(
      formatAutomationRunLaunchSettings(
        {
          agentId: 'claude',
          options: {
            model: { value: 'sonnet', source: 'explicit' },
            effort: { value: 'high', source: 'explicit' }
          },
          agentArgs: { value: '--verbose', source: 'explicit' }
        },
        'Claude Code'
      )
    ).toEqual({
      summary: 'Claude Code · Sonnet · Effort: high',
      agentArgs: '--verbose'
    })
  })

  it('omits values shadowed by raw arguments', () => {
    expect(
      formatAutomationRunLaunchSettings(
        {
          agentId: 'claude',
          options: {
            model: { source: 'raw_args' },
            effort: { source: 'raw_args' }
          },
          agentArgs: { value: '--model opus --effort max', source: 'explicit' }
        },
        'Claude Code'
      )
    ).toEqual({
      summary: 'Claude Code',
      agentArgs: '--model opus --effort max'
    })
  })

  it('preserves opaque ids and formats boolean options truthfully', () => {
    expect(
      formatAutomationRunLaunchSettings(
        {
          agentId: 'claude',
          options: {
            model: { value: 'future-model', source: 'explicit' },
            fastMode: { value: true, source: 'explicit' },
            custom: { value: false, source: 'explicit' }
          }
        },
        'Claude Code'
      )
    ).toEqual({
      summary: 'Claude Code · future-model · Fast mode · custom: Off',
      agentArgs: null
    })
  })

  it('returns null for legacy runs without launch settings', () => {
    expect(formatAutomationRunLaunchSettings(null, 'Codex')).toBeNull()
  })
})
