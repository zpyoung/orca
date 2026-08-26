import { describe, expect, it } from 'vitest'
import { buildCommitMessageGenerationParams } from './SourceControlTextGenerationParams'

describe('buildCommitMessageGenerationParams', () => {
  it('applies recipe options before raw one-shot arguments while preserving sparse recipe state', () => {
    expect(
      buildCommitMessageGenerationParams({
        agentId: 'claude',
        commandTemplate: '{basePrompt}',
        agentArgs: '--model opus',
        launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } },
        baseParams: null,
        settings: null
      })
    ).toMatchObject({
      agentId: 'claude',
      model: 'sonnet',
      thinkingLevel: 'high',
      agentArgs: "'--model' 'sonnet' '--effort' 'high' '--model' 'opus'",
      recipeAgentArgs: '--model opus',
      launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } }
    })
  })

  it('keeps malformed raw arguments available for planner validation', () => {
    expect(
      buildCommitMessageGenerationParams({
        agentId: 'claude',
        commandTemplate: '{basePrompt}',
        agentArgs: '--model "unterminated',
        launchOptions: { model: 'sonnet' },
        baseParams: null,
        settings: null
      })?.agentArgs
    ).toBe('--model "unterminated')
  })
})
