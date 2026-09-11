import { afterEach, describe, expect, it } from 'vitest'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from '../tui-agent-startup'
import { buildAgentResumeStartupPlan } from '../tui-agent-resume-startup'
import {
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
} from './claude-suppression-flags'
import { setLocalClaudeSuppressionVerdictReader } from './claude-suppression-verdict'

/**
 * The whole feature was once composition code that no launch ever reached, so these assert the
 * finished launch command a pane actually spawns — not the composition helper in isolation.
 */
const FLAGS = [
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
]
const suppression =
  `'${CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG}' '${CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE}'` +
  ` '${CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG}' '${CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE}'`

const base = { cmdOverrides: {}, platform: 'darwin' as const, shell: 'posix' as const }

afterEach(() => {
  setLocalClaudeSuppressionVerdictReader(null)
})

describe('a managed Claude launch under an above-floor local verdict', () => {
  it('carries both flags ahead of the prompt argv', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const plan = buildAgentStartupPlan({ ...base, agent: 'claude', prompt: 'fix the build' })

    // the prompt stays last: a flag appended after it would be read as part of the prompt
    expect(plan?.launchCommand).toBe(`claude ${suppression} 'fix the build'`)
  })

  it('carries both flags on an empty-prompt launch', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const plan = buildAgentStartupPlan({
      ...base,
      agent: 'claude',
      prompt: '',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe(`claude ${suppression}`)
  })

  it('carries both flags ahead of a draft prefill', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const plan = buildAgentDraftLaunchPlan({ ...base, agent: 'claude', draft: 'half a thought' })

    expect(plan?.launchCommand).toBe(`claude ${suppression} --prefill 'half a thought'`)
  })

  it('carries both flags ahead of the resume argv', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const plan = buildAgentResumeStartupPlan({
      ...base,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' }
    })

    expect(plan?.launchCommand).toContain(suppression)
    expect(plan?.launchCommand.indexOf(suppression)).toBeLessThan(
      plan?.launchCommand.indexOf('sess-1') ?? -1
    )
  })

  it('leaves other agents untouched', () => {
    setLocalClaudeSuppressionVerdictReader(() => FLAGS)

    const plan = buildAgentStartupPlan({ ...base, agent: 'codex', prompt: 'fix the build' })

    expect(plan?.launchCommand).not.toContain(CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE)
  })
})

describe('a managed Claude launch with no verdict yet', () => {
  it('is byte-identical to the unsuppressed command', () => {
    const plan = buildAgentStartupPlan({ ...base, agent: 'claude', prompt: 'fix the build' })

    expect(plan?.launchCommand).toBe("claude 'fix the build'")
  })
})
