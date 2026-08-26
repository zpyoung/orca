import { describe, expect, it } from 'vitest'
import { agentLaunchOverridesToSessionOptionValues } from './agent-launch-overrides'
import { buildAutomationRunLaunchSettings } from './automation-run-launch-settings'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('buildAutomationRunLaunchSettings', () => {
  it('records explicit structured launch values', () => {
    expect(
      buildAutomationRunLaunchSettings({
        agentId: 'claude',
        overrides: { model: 'sonnet', optionValues: { effort: 'high' } },
        effectiveAgentArgs: '',
        agentArgsSource: 'inherited'
      })
    ).toEqual({
      agentId: 'claude',
      options: {
        model: { value: 'sonnet', source: 'explicit' },
        effort: { value: 'high', source: 'explicit' }
      }
    })
  })

  it('records a picked option shadowed by explicit raw arguments', () => {
    expect(
      buildAutomationRunLaunchSettings({
        agentId: 'claude',
        overrides: {
          model: 'sonnet',
          optionValues: { effort: 'high' },
          agentArgs: '--effort low'
        },
        effectiveAgentArgs: '--effort low',
        agentArgsSource: 'explicit'
      })
    ).toEqual({
      agentId: 'claude',
      options: {
        model: { value: 'sonnet', source: 'explicit' },
        effort: { source: 'raw_args' }
      },
      agentArgs: { value: '--effort low', source: 'explicit' }
    })
  })

  it('records shadowing inherited arguments with inherited provenance', () => {
    expect(
      buildAutomationRunLaunchSettings({
        agentId: 'codex',
        overrides: { model: 'gpt-5.5', optionValues: { effort: 'high' } },
        effectiveAgentArgs: '-c model_reasoning_effort=low',
        agentArgsSource: 'inherited'
      })
    ).toEqual({
      agentId: 'codex',
      options: {
        model: { value: 'gpt-5.5', source: 'explicit' },
        effort: { source: 'raw_args' }
      },
      agentArgs: { value: '-c model_reasoning_effort=low', source: 'inherited' }
    })
  })

  it('does not invent a parsed value for a model set by raw arguments', () => {
    expect(
      buildAutomationRunLaunchSettings({
        agentId: 'claude',
        overrides: { model: 'sonnet', optionValues: { effort: 'high' } },
        effectiveAgentArgs: '--model haiku',
        agentArgsSource: 'inherited'
      })
    ).toEqual({
      agentId: 'claude',
      options: {
        model: { source: 'raw_args' }
      },
      agentArgs: { value: '--model haiku', source: 'inherited' }
    })
  })

  it('records raw arguments alone and collapses an empty launch', () => {
    expect(
      buildAutomationRunLaunchSettings({
        agentId: 'amp',
        overrides: undefined,
        effectiveAgentArgs: '--profile nightly',
        agentArgsSource: 'inherited'
      })
    ).toEqual({
      agentId: 'amp',
      options: {},
      agentArgs: { value: '--profile nightly', source: 'inherited' }
    })
    expect(
      buildAutomationRunLaunchSettings({
        agentId: 'amp',
        overrides: undefined,
        effectiveAgentArgs: '',
        agentArgsSource: 'inherited'
      })
    ).toBeNull()
  })

  it('matches the values reported by the startup plan', () => {
    const overrides = {
      model: 'sonnet',
      optionValues: { effort: 'high' },
      agentArgs: '--effort low'
    }
    const launchSettings = buildAutomationRunLaunchSettings({
      agentId: 'claude',
      overrides,
      effectiveAgentArgs: overrides.agentArgs,
      agentArgsSource: 'explicit'
    })
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      agentArgs: overrides.agentArgs,
      sessionOptions: agentLaunchOverridesToSessionOptionValues(overrides),
      includeSessionOptionCatalogDefaults: false
    })
    const recordedValues = Object.fromEntries(
      Object.entries(launchSettings?.options ?? {}).flatMap(([id, setting]) =>
        setting.value === undefined ? [] : [[id, setting.value]]
      )
    )
    expect(recordedValues).toEqual(plan?.sessionOptions)
  })
})
