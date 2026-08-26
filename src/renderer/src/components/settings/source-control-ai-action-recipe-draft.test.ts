import { describe, expect, it } from 'vitest'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import {
  actionRecipeDraftToAgentLaunchOverrides,
  agentLaunchOptionSelectionFromOverrides,
  readActionRecipeInputValues
} from './source-control-ai-action-recipe-draft'
import {
  readActionRecipeTextDraft,
  toRepoActionLaunchOptions
} from './repository-source-control-ai-action-draft'
import { computeActionDirtyById, withRepoAiActionAgent } from './repository-source-control-ai-draft'

describe('source-control action recipe launch drafts', () => {
  it('maps sibling launch options and top-level agent args into the shared edit shape', () => {
    const config: SourceControlAiSettings = {
      enabled: true,
      agentId: null,
      selectedModelByAgent: {},
      selectedThinkingByModel: {},
      customAgentCommand: '',
      instructionsByOperation: {},
      actions: {
        fixChecks: {
          agentArgs: '--verbose',
          launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } }
        }
      }
    }
    const values = readActionRecipeInputValues(config)

    expect(actionRecipeDraftToAgentLaunchOverrides(values.fixChecks)).toEqual({
      model: 'sonnet',
      optionValues: { effort: 'high' },
      agentArgs: '--verbose'
    })
    expect(
      agentLaunchOptionSelectionFromOverrides({
        model: 'opus',
        optionValues: { effort: 'low' },
        agentArgs: '--debug'
      })
    ).toEqual({ model: 'opus', optionValues: { effort: 'low' } })
  })

  it('uses null to clear inherited repository launch options', () => {
    expect(toRepoActionLaunchOptions({})).toBeNull()
    expect(toRepoActionLaunchOptions({ model: ' sonnet ' })).toEqual({ model: 'sonnet' })

    const next = withRepoAiActionAgent(
      {
        actionOverrides: {
          fixChecks: {
            agentId: 'claude',
            agentArgs: '--verbose',
            launchOptions: { model: 'sonnet' }
          }
        }
      },
      null,
      'fixChecks',
      'codex'
    )

    expect(next.actionOverrides?.fixChecks).toMatchObject({
      agentId: 'codex',
      agentArgs: '--verbose',
      launchOptions: null
    })
  })

  it('tracks repository launch-option drafts as unsaved recipe changes', () => {
    const recipe = {
      actionOverrides: {
        fixChecks: {
          agentId: 'claude' as const,
          commandInputTemplate: '{basePrompt}',
          launchOptions: { model: 'sonnet' }
        }
      }
    }
    const draft = readActionRecipeTextDraft(recipe, 'fixChecks')
    const dirty = computeActionDirtyById(recipe, recipe, {
      fixChecks: { ...draft, launchOptions: { model: 'opus' } }
    })

    expect(dirty.fixChecks).toBe(true)
  })
})
