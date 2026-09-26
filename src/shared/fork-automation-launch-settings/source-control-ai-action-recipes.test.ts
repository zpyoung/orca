import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../constants'
import {
  resolveSourceControlActionRecipe,
  resolveSourceControlAiForOperation
} from '../source-control-ai'
import type { GlobalSettings } from '../global-settings-types'

function settings(): GlobalSettings {
  const base = getDefaultSettings('/tmp')
  return {
    ...base,
    defaultTuiAgent: 'codex' as const,
    sourceControlAi: {
      ...base.sourceControlAi!,
      enabled: true,
      agentId: 'codex' as const,
      selectedModelByAgent: { codex: 'gpt-5.5' },
      selectedThinkingByModel: { 'gpt-5.5': 'medium', 'gpt-5.4': 'high' },
      instructionsByOperation: {
        commitMessage: 'Global commit style',
        pullRequest: 'Global PR style',
        branchName: 'Global branch style'
      }
    }
  }
}

describe('source-control AI launch recipes', () => {
  it('inherits, overrides, and clears structured launch options per repository', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        fixChecks: {
          agentId: 'claude',
          commandInputTemplate: '{basePrompt}',
          launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } }
        }
      }
    }

    const resolve = (launchOptions?: { model: string } | null) =>
      resolveSourceControlActionRecipe({
        settings: base,
        repo: {
          sourceControlAi: {
            actionOverrides: {
              fixChecks: {
                agentArgs: '--verbose',
                ...(launchOptions !== undefined ? { launchOptions } : {})
              }
            }
          }
        },
        actionId: 'fixChecks'
      })

    expect(resolve()).toMatchObject({
      agentArgs: '--verbose',
      launchOptions: { model: 'sonnet', optionValues: { effort: 'high' } }
    })
    expect(resolve({ model: 'opus' })).toMatchObject({
      launchOptions: { model: 'opus' }
    })
    expect(resolve(null)).not.toHaveProperty('launchOptions')
  })

  it('carries resolved text-action launch options into generation params', () => {
    const base = settings()
    base.sourceControlAi = {
      ...base.sourceControlAi!,
      actions: {
        ...base.sourceControlAi!.actions,
        commitMessage: {
          agentId: 'codex',
          commandInputTemplate: '{basePrompt}',
          launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'high' } }
        }
      }
    }

    expect(
      resolveSourceControlAiForOperation({
        settings: base,
        repo: null,
        operation: 'commitMessage',
        discoveryHostKey: 'local'
      })
    ).toMatchObject({
      ok: true,
      value: {
        params: {
          launchOptions: { model: 'gpt-5.5', optionValues: { effort: 'high' } }
        }
      }
    })
  })
})
