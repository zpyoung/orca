import { describe, expect, it } from 'vitest'
import { planCommitMessageGeneration } from '../commit-message-plan'

describe('commit-message launch recipe arguments', () => {
  it('lets Claude recipe arguments replace generated model and effort flags', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'claude',
        model: 'sonnet',
        thinkingLevel: 'low',
        agentArgs: '--model opus --effort high --verbose'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          '-p',
          '--output-format',
          'text',
          '--model',
          'opus',
          '--permission-mode',
          'plan',
          '--effort',
          'high',
          '--verbose'
        ]
      }
    })
  })

  it('uses the first Codex singleton recipe flags without leaving duplicates', () => {
    const result = planCommitMessageGeneration(
      {
        agentId: 'codex',
        model: 'gpt-5.4-mini',
        thinkingLevel: 'medium',
        agentArgs:
          '--model gpt-5.4 --model gpt-5.5 -c model_reasoning_effort=low -c model_reasoning_effort=high --sandbox read-only'
      },
      'PROMPT'
    )

    expect(result).toMatchObject({
      ok: true,
      plan: {
        args: [
          'exec',
          '--ephemeral',
          '--skip-git-repo-check',
          '-s',
          'read-only',
          '--model',
          'gpt-5.4',
          '-c',
          'model_reasoning_effort=low',
          '--sandbox',
          'read-only'
        ]
      }
    })
  })
})
