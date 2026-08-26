import {
  normalizeAgentLaunchOverrides,
  type AgentLaunchOptionSelection
} from '../../../../shared/agent-launch-overrides'
import type { SourceControlActionId } from '../../../../shared/source-control-ai-actions'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'

export type ActionRecipeTextDraft = {
  commandInputTemplate: string
  agentArgs: string
  launchOptions?: AgentLaunchOptionSelection | null
}

export function readActionRecipeTextDraft(
  value: RepoSourceControlAiOverrides,
  actionId: SourceControlActionId
): ActionRecipeTextDraft {
  const recipe = value.actionOverrides?.[actionId]
  return {
    commandInputTemplate:
      typeof recipe?.commandInputTemplate === 'string' ? recipe.commandInputTemplate : '',
    agentArgs: typeof recipe?.agentArgs === 'string' ? recipe.agentArgs : '',
    ...(recipe?.launchOptions !== undefined
      ? { launchOptions: structuredClone(recipe.launchOptions) }
      : {})
  }
}

export function toRepoActionLaunchOptions(
  value: AgentLaunchOptionSelection
): AgentLaunchOptionSelection | null {
  const normalized = normalizeAgentLaunchOverrides(value)
  if (!normalized?.model && !normalized?.optionValues) {
    return null
  }
  return {
    ...(normalized.model ? { model: normalized.model } : {}),
    ...(normalized.optionValues ? { optionValues: normalized.optionValues } : {})
  }
}
