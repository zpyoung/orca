import { describe, expect, it } from 'vitest'
import { generationParamsToActionRecipe } from '../source-control/ai/text-generation-defaults'

describe('generationParamsToActionRecipe', () => {
  it('persists sparse launch choices instead of resolved one-shot arguments', () => {
    expect(
      generationParamsToActionRecipe({
        agentId: 'claude',
        model: 'sonnet',
        commandInputTemplate: '{basePrompt}',
        agentArgs: "'--model' 'sonnet' '--model' 'opus'",
        recipeAgentArgs: '--model opus',
        launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } }
      })
    ).toEqual({
      agentId: 'claude',
      commandInputTemplate: '{basePrompt}',
      agentArgs: '--model opus',
      launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } }
    })
  })
})
