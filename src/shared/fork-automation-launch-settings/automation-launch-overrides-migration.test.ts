import { describe, expect, it } from 'vitest'
import type { Automation } from '../automations-types'
import {
  foldLegacyLaunchAgentArgs,
  legacyLaunchOverridesAgentArgs,
  migrateLegacyAutomationLaunchArgs,
  normalizeAutomationLaunchOverrides
} from './automation-launch-overrides-migration'
import { legacyLaunchOverrides } from './legacy-launch-overrides.test-support'

function automationWith(fields: Partial<Automation>): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the migration reads only the launch fields these cases set.
  return { id: 'auto-1', agentId: 'claude', ...fields } as Automation
}

describe('automation launch overrides migration', () => {
  it('drops retired raw arguments from the normalized selection', () => {
    expect(
      normalizeAutomationLaunchOverrides({
        model: ' sonnet ',
        optionValues: { effort: 'high' },
        agentArgs: '--verbose'
      })
    ).toEqual({ model: 'sonnet', optionValues: { effort: 'high' } })
    expect(normalizeAutomationLaunchOverrides({ agentArgs: '--verbose' })).toBeUndefined()
  })

  it('reads the retired raw arguments only when non-blank', () => {
    expect(legacyLaunchOverridesAgentArgs({ model: 'a', agentArgs: '--x' })).toBe('--x')
    expect(legacyLaunchOverridesAgentArgs({ agentArgs: '   ' })).toBeUndefined()
    expect(legacyLaunchOverridesAgentArgs(null)).toBeUndefined()
  })

  it('appends to existing extras with a space and leaves other values alone', () => {
    expect(foldLegacyLaunchAgentArgs('--effort high', '--add-dir docs')).toBe(
      '--effort high --add-dir docs'
    )
    expect(foldLegacyLaunchAgentArgs('  ', '--add-dir docs')).toBe('--add-dir docs')
    expect(foldLegacyLaunchAgentArgs(undefined, '--add-dir docs')).toBe('--add-dir docs')
    expect(foldLegacyLaunchAgentArgs('--effort high', undefined)).toBe('--effort high')
    expect(foldLegacyLaunchAgentArgs(42, undefined)).toBe(42)
  })

  it('moves a stored raw argument string into extraAgentArgs', () => {
    expect(
      migrateLegacyAutomationLaunchArgs(
        automationWith({
          launchOverrides: legacyLaunchOverrides({ model: 'sonnet', agentArgs: '--add-dir docs' })
        })
      )
    ).toMatchObject({
      extraAgentArgs: '--add-dir docs',
      launchOverrides: { model: 'sonnet' }
    })
  })

  it('removes launchOverrides entirely when only raw arguments were stored', () => {
    const migrated = migrateLegacyAutomationLaunchArgs(
      automationWith({
        extraAgentArgs: '--effort high',
        launchOverrides: legacyLaunchOverrides({ agentArgs: '--add-dir docs' })
      })
    )
    expect(migrated.extraAgentArgs).toBe('--effort high --add-dir docs')
    expect(Object.hasOwn(migrated, 'launchOverrides')).toBe(false)
  })

  it('returns the same record when there is nothing to migrate', () => {
    const automation = automationWith({ launchOverrides: { model: 'sonnet' } })
    expect(migrateLegacyAutomationLaunchArgs(automation)).toBe(automation)
  })
})
