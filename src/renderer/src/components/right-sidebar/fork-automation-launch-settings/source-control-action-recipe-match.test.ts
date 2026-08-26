import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { sourceControlActionRecipeMatchesTarget } from '../source-control-action-recipe-match'

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex',
      actions: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--model sonnet'
        }
      }
    }
  }
}

describe('source-control action launch recipe matching', () => {
  it('returns false when structured launch options differ', () => {
    const currentSettings = settings()
    currentSettings.sourceControlAi = {
      ...currentSettings.sourceControlAi!,
      actions: {
        resolveConflicts: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '',
          launchOptions: { model: 'gpt-5.3', optionValues: { effort: 'high' } }
        }
      }
    }

    expect(
      sourceControlActionRecipeMatchesTarget({
        actionId: 'resolveConflicts',
        target: { type: 'global' },
        recipe: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          agentArgs: '',
          launchOptions: { model: 'gpt-5.3', optionValues: { effort: 'medium' } }
        },
        settings: currentSettings
      })
    ).toBe(false)
  })
})
