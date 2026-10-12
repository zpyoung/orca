import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../shared/automations-types'
import { resolveAutomationRunLaunchSettings } from './automation-run-launch-settings'

function automationWith(fields: Partial<Automation>): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot reads only the agent and launch fields these cases set.
  return { id: 'auto-1', agentId: 'claude', ...fields } as Automation
}

describe('resolveAutomationRunLaunchSettings', () => {
  it('snapshots saved extras as explicit arguments', () => {
    const settings = resolveAutomationRunLaunchSettings({
      automation: automationWith({ extraAgentArgs: '--add-dir docs' }),
      settings: { agentDefaultArgs: { claude: '--verbose' } },
      platform: 'linux',
      isRemote: false
    })

    expect(settings?.agentArgs?.source).toBe('explicit')
    expect(settings?.agentArgs?.value).toContain('--verbose')
    expect(settings?.agentArgs?.value).toContain('--add-dir')
  })

  it('keeps the inherited arguments when no extras are saved', () => {
    const settings = resolveAutomationRunLaunchSettings({
      automation: automationWith({ launchOverrides: { model: 'sonnet' } }),
      settings: { agentDefaultArgs: { claude: '--verbose' } },
      platform: 'linux',
      isRemote: false
    })

    expect(settings?.agentArgs).toEqual({ value: '--verbose', source: 'inherited' })
    expect(settings?.options.model).toEqual({ value: 'sonnet', source: 'explicit' })
  })
})
