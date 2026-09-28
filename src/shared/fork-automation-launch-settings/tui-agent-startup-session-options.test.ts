import { describe, expect, it } from 'vitest'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../tui-agent-startup'

describe('automation launch startup session options', () => {
  it('replaces a shadowed raw flag for automation launch overrides', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'gpt-5.5' },
      sessionOptionsOverrideAgentArgs: true,
      includeSessionOptionCatalogDefaults: false,
      agentArgs: '--model gpt-5.4 --search'
    })
    // codex rejects a repeated model flag, so the structured value must replace
    // the raw one rather than trail it.
    expect(plan?.launchCommand).toBe("codex '--search' '-m' 'gpt-5.5'")
    expect(plan?.launchCommand).not.toContain('gpt-5.4')
  })

  it('can suppress catalog defaults while preserving raw-args precedence', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'sonnet' },
      agentArgs: '--effort low',
      includeSessionOptionCatalogDefaults: false
    })
    expect(plan?.launchCommand).toBe("claude '--model' 'sonnet' '--effort' 'low'")
    expect(plan?.sessionOptions).toEqual({ model: 'sonnet' })
  })

  it('preserves catalog defaults when the new flag is absent', () => {
    const rawArgsWin = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'sonnet' }
    })
    const sessionOptionsWin = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'sonnet' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(rawArgsWin?.sessionOptions).toEqual({ model: 'sonnet', effort: 'high' })
    expect(sessionOptionsWin?.sessionOptions).toEqual({ model: 'sonnet' })
  })

  it('threads catalog-default suppression through draft launch planning', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'claude',
      draft: 'review this',
      cmdOverrides: {},
      platform: 'linux',
      sessionOptions: { model: 'sonnet' },
      includeSessionOptionCatalogDefaults: false
    })
    expect(plan?.launchCommand).toContain("claude '--model' 'sonnet'")
    expect(plan?.launchCommand).not.toContain('--effort')
    expect(plan?.sessionOptions).toEqual({ model: 'sonnet' })
  })
})
