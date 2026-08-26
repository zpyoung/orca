import {
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  SOURCE_CONTROL_TEXT_ACTION_LABELS,
  type SourceControlTextActionId
} from '../../../../shared/source-control-ai-actions'
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai'
import type { GlobalSettings } from '../../../../shared/types'

export type TextGenerationRecipeOverrides = {
  modelOverriddenBy: SourceControlTextActionId[]
  thinkingOverriddenBy: SourceControlTextActionId[]
}

/** Describe text-generation pickers whose values are replaced by saved action recipes. */
export function describeTextGenerationRecipeOverrides(
  settings: Pick<GlobalSettings, 'sourceControlAi' | 'commitMessageAi'> | null | undefined
): TextGenerationRecipeOverrides {
  return SOURCE_CONTROL_TEXT_ACTION_IDS.reduce<TextGenerationRecipeOverrides>(
    (result, actionId) => {
      const options = resolveSourceControlActionRecipe({ actionId, settings }).launchOptions
      if (options?.model) {
        result.modelOverriddenBy.push(actionId)
      }
      if (options?.optionValues?.effort) {
        result.thinkingOverriddenBy.push(actionId)
      }
      return result
    },
    { modelOverriddenBy: [], thinkingOverriddenBy: [] }
  )
}

/** Format the action labels named by a partial recipe override. */
export function formatTextGenerationRecipeOverrideActions(
  actionIds: SourceControlTextActionId[]
): string {
  return actionIds.map((actionId) => SOURCE_CONTROL_TEXT_ACTION_LABELS[actionId]).join(', ')
}
