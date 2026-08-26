import type { JSX } from 'react'
import {
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlTextActionId
} from '../../../../../shared/source-control-ai-actions'
import { translate } from '@/i18n/i18n'
import { formatTextGenerationRecipeOverrideActions } from './text-generation-recipe-overrides'

/** Show which source-control recipes override a commit-message option. */
export function RecipeOverrideNote({
  actionIds
}: {
  actionIds: SourceControlTextActionId[]
}): JSX.Element | null {
  if (actionIds.length === 0) {
    return null
  }
  const allActions = actionIds.length === SOURCE_CONTROL_TEXT_ACTION_IDS.length
  return (
    <p className="text-[11px] leading-snug text-muted-foreground">
      {allActions
        ? translate(
            'auto.components.feature.wall.AiCommitPrSettingsFields.a8a91aa917',
            'Set by action recipes.'
          )
        : translate(
            'auto.components.feature.wall.AiCommitPrSettingsFields.b66be73624',
            'Overridden for {{value0}} by its action recipe.',
            { value0: formatTextGenerationRecipeOverrideActions(actionIds) }
          )}
    </p>
  )
}
