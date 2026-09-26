import { describe, expect, it } from 'vitest'
import { normalizeWritableRepoSourceControlAiOverrides } from '../source-control-ai-recipe-save'

describe('source-control launch recipe saves', () => {
  it('preserves repository null launch options as an explicit inherited-value clear', () => {
    expect(
      normalizeWritableRepoSourceControlAiOverrides({
        actionOverrides: {
          fixChecks: { launchOptions: null }
        }
      })
    ).toEqual({
      actionOverrides: {
        fixChecks: {
          agentId: null,
          commandInputTemplate: '{basePrompt}',
          launchOptions: null
        }
      }
    })
  })
})
