import { describe, expect, it } from 'vitest'
import { describeTextGenerationRecipeOverrides } from './text-generation-recipe-overrides'

describe('describeTextGenerationRecipeOverrides', () => {
  it('returns no overrides without recipes', () => {
    expect(describeTextGenerationRecipeOverrides(undefined)).toEqual({
      modelOverriddenBy: [],
      thinkingOverriddenBy: []
    })
  })

  it('tracks model and effort overrides independently', () => {
    expect(
      describeTextGenerationRecipeOverrides({
        sourceControlAi: {
          enabled: true,
          agentId: 'claude',
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          discoveredModelsByAgent: {},
          customAgentCommand: '',
          instructionsByOperation: {},
          actions: {
            commitMessage: { launchOptions: { model: 'opus' } },
            pullRequest: { launchOptions: { optionValues: { effort: 'high' } } },
            branchName: {
              launchOptions: { model: 'sonnet', optionValues: { effort: 'low' } }
            }
          }
        }
      })
    ).toEqual({
      modelOverriddenBy: ['commitMessage', 'branchName'],
      thinkingOverriddenBy: ['pullRequest', 'branchName']
    })
  })

  it('tracks complete model coverage independently from thinking coverage', () => {
    expect(
      describeTextGenerationRecipeOverrides({
        sourceControlAi: {
          enabled: true,
          agentId: 'claude',
          selectedModelByAgent: {},
          selectedThinkingByModel: {},
          discoveredModelsByAgent: {},
          customAgentCommand: '',
          instructionsByOperation: {},
          actions: {
            commitMessage: { launchOptions: { model: 'opus' } },
            pullRequest: { launchOptions: { model: 'opus' } },
            branchName: { launchOptions: { model: 'opus' } }
          }
        }
      }).modelOverriddenBy
    ).toEqual(['commitMessage', 'pullRequest', 'branchName'])
  })
})
