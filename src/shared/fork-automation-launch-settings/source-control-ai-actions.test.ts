import { describe, expect, it } from 'vitest'
import { normalizeSourceControlActionRecipe } from '../source-control-ai-actions'

describe('source-control structured launch options', () => {
  it('sanitizes structured launch options without moving top-level agent args', () => {
    const launchOptions = JSON.parse(
      '{"model":" sonnet ","optionValues":{"effort":"high","constructor":"bad","fastMode":42},"agentArgs":"--nested"}'
    )

    expect(
      normalizeSourceControlActionRecipe({
        agentArgs: ' --verbose ',
        launchOptions
      })
    ).toEqual({
      agentArgs: ' --verbose ',
      launchOptions: {
        model: 'sonnet',
        optionValues: { effort: 'high' }
      }
    })
  })
})
