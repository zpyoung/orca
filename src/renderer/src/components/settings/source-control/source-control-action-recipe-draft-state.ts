<<<<<<< fork
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentLaunchOptionSelection } from '../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
||||||| base
import { useEffect, useMemo, useRef, useState } from 'react'
=======
import {
  transportActionArgumentChoices,
  demoteActionArgumentChoices,
  type ActionArgumentChoices
} from '../../../../../shared/source-control-action-argument-document'
import { liftActionPermissionArgs } from '../../../../../shared/source-control-action-permission-lift'
import { useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
>>>>>>> upstream
import type {
  SourceControlAiSettings,
  SourceControlAiModelChoice,
  SourceControlAiSettingsPatch
} from '../../../../../shared/source-control-ai-types'
import {
  setSourceControlActionDefault,
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  type SourceControlActionLaunchPreferences,
  type SourceControlActionId
} from '../../../../../shared/source-control-ai-actions'
import type { SourceControlAiModelEdits } from '../../../../../shared/source-control-ai-action-model-edits'
import { replayGlobalTextModelEdits } from '../source-control-text-action-model-replay'
import {
  type ActionRecipeDraftState,
  readActionRecipeInputValues,
  serializeActionRecipeInputValues
} from './source-control-ai-action-recipe-draft'

type UseSourceControlActionRecipeDraftStateArgs = {
  config: SourceControlAiSettings
  customPromptDiscardSignal?: number
  onCustomPromptDirtyChange?: (dirty: boolean) => void
  writeConfig: (patch: SourceControlAiSettingsPatch) => Promise<void>
}

/** A model choice the user did not edit in the menu follows the saved one, so another editor's newer pick shows. */
function rebaseUneditedModelChoices(
  draft: ActionRecipeDraftState['values'],
  persisted: ActionRecipeDraftState['values']
): ActionRecipeDraftState['values'] {
  const values = { ...draft }
  for (const actionId of SOURCE_CONTROL_TEXT_ACTION_IDS) {
    const value = values[actionId]
    if (!value.modelEdits?.length) {
      values[actionId] = { ...value, modelChoice: persisted[actionId].modelChoice }
    }
  }
  return values
}

/**
 * Follow a newly saved recipe unless the user still has their own change. Both the draft and its
 * old base take unedited model choices from the new save, so another editor's model pick is never
 * mistaken for a local edit.
 */
function followPersistedRecipeValues(
  current: ActionRecipeDraftState,
  persisted: ActionRecipeDraftState['values']
): ActionRecipeDraftState {
  const values = rebaseUneditedModelChoices(current.values, persisted)
  const serialized = serializeActionRecipeInputValues(values)
  if (
    serialized ===
      serializeActionRecipeInputValues(rebaseUneditedModelChoices(current.baseValues, persisted)) ||
    serialized === serializeActionRecipeInputValues(persisted)
  ) {
    return { values: persisted, baseValues: persisted }
  }
  return { values, baseValues: persisted }
}

export function useSourceControlActionRecipeDraftState({
  config,
  customPromptDiscardSignal,
  onCustomPromptDirtyChange,
  writeConfig
}: UseSourceControlActionRecipeDraftStateArgs) {
  const persistedActionRecipeValues = useMemo(() => readActionRecipeInputValues(config), [config])
  const persistedActionRecipeValuesRef = useRef(persistedActionRecipeValues)
  persistedActionRecipeValuesRef.current = persistedActionRecipeValues
<<<<<<< fork
  const [actionRecipeDraftState, setActionRecipeDraftState] = useState<ActionRecipeDraftState>(
    () => ({
      values: persistedActionRecipeValues,
      baseValues: persistedActionRecipeValues
    })
  )
  const [savingActionRecipeIds, setSavingActionRecipeIds] = useState<
||||||| base
  const [actionRecipeDraftState, setActionRecipeDraftState] = useState<ActionRecipeDraftState>(
    () => ({
      values: persistedActionRecipeValues,
      baseValues: persistedActionRecipeValues
    })
  )
  const [savingActionTemplateIds, setSavingActionTemplateIds] = useState<
=======
  const [storedDraftState, setActionRecipeDraftState] = useState<ActionRecipeDraftState>(() => ({
    values: persistedActionRecipeValues,
    baseValues: persistedActionRecipeValues
  }))
  // Adjusted during render so a newer save shows in the same frame the settings change.
  const [followedPersisted, setFollowedPersisted] = useState(persistedActionRecipeValues)
  let actionRecipeDraftState = storedDraftState
  if (followedPersisted !== persistedActionRecipeValues) {
    actionRecipeDraftState = followPersistedRecipeValues(
      storedDraftState,
      persistedActionRecipeValues
    )
    setFollowedPersisted(persistedActionRecipeValues)
    setActionRecipeDraftState((current) =>
      followPersistedRecipeValues(current, persistedActionRecipeValues)
    )
  }
  const [savingActionTemplateIds, setSavingActionTemplateIds] = useState<
>>>>>>> upstream
    Partial<Record<SourceControlActionId, boolean>>
  >({})
  const actionRecipeDraftSerialized = useMemo(
    () => serializeActionRecipeInputValues(actionRecipeDraftState.values),
    [actionRecipeDraftState.values]
  )
  const actionRecipeBaseSerialized = useMemo(
    () => serializeActionRecipeInputValues(actionRecipeDraftState.baseValues),
    [actionRecipeDraftState.baseValues]
  )
  const actionRecipeDirty = actionRecipeDraftSerialized !== actionRecipeBaseSerialized

  useEffect(() => {
    setActionRecipeDraftState({
      values: persistedActionRecipeValuesRef.current,
      baseValues: persistedActionRecipeValuesRef.current
    })
  }, [customPromptDiscardSignal])

  useEffect(() => {
    onCustomPromptDirtyChange?.(actionRecipeDirty)
  }, [actionRecipeDirty, onCustomPromptDirtyChange])

  useEffect(
    () => () => {
      onCustomPromptDirtyChange?.(false)
    },
    [onCustomPromptDirtyChange]
  )

  const onActionTemplateChange = (actionId: SourceControlActionId, value: string): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: {
          ...current.values[actionId],
          commandInputTemplate: value
        }
      }
    }))
  }

  const onActionAgentArgsChange = (
    actionId: SourceControlActionId,
    value: string,
    commit = false
  ): void => {
    setActionRecipeDraftState((current) => {
      const { agentId: _binding, ...valueDraft } = commit
        ? liftActionPermissionArgs(
            {
              ...current.values[actionId],
              agentId: config.actions?.[actionId]?.agentId,
              argumentChoices: transportActionArgumentChoices(current.values[actionId], value),
              agentArgs: value
            },
            true,
            actionId
          )
        : {
            ...current.values[actionId],
            agentId: config.actions?.[actionId]?.agentId,
            argumentChoices: transportActionArgumentChoices(current.values[actionId], value),
            agentArgs: value
          }
      return { ...current, values: { ...current.values, [actionId]: valueDraft } }
    })
  }

  const onActionLaunchPreferencesChange = (
    actionId: SourceControlActionId,
    update: SetStateAction<SourceControlActionLaunchPreferences | undefined>,
    userArgs?: string,
    argumentChoices?: ActionArgumentChoices | null
  ): void => {
    setActionRecipeDraftState((current) => {
      const latest = current.values[actionId].launchPreferences
      const next = typeof update === 'function' ? update(latest) : update
      // A completion with no owned change must not materialize an explicit clear.
      if (typeof update === 'function' && next === latest) {
        return current
      }
      return {
        ...current,
        values: {
          ...current.values,
          [actionId]: {
            ...current.values[actionId],
            launchPreferences: next,
            ...(argumentChoices !== undefined
              ? { argumentChoices: argumentChoices ?? undefined }
              : {}),
            ...(userArgs !== undefined ? { agentArgs: userArgs } : {})
          }
        }
      }
    })
  }

  const onTextModelChoiceChange = (
    actionId: SourceControlActionId,
    modelChoice: SourceControlAiModelChoice | undefined,
    agentArgs: string,
    modelEdits: SourceControlAiModelEdits | undefined
  ): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: { ...current.values[actionId], modelChoice, agentArgs, modelEdits }
      }
    }))
  }

<<<<<<< fork
  const onActionLaunchOptionsChange = (
    actionId: SourceControlActionId,
    launchOptions: AgentLaunchOptionSelection
  ): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: { ...current.values[actionId], launchOptions }
      }
    }))
  }

  const resetActionLaunchOptions = (actionId: SourceControlActionId): void => {
    setActionRecipeDraftState((current) => ({
      values: {
        ...current.values,
        [actionId]: { ...current.values[actionId], launchOptions: {} }
      },
      baseValues: {
        ...current.baseValues,
        [actionId]: { ...current.baseValues[actionId], launchOptions: {} }
      }
    }))
  }

  const saveActionRecipeDraft = async (actionId: SourceControlActionId): Promise<void> => {
    const nextValue = actionRecipeDraftState.values[actionId]
||||||| base
  const saveActionTemplateDraft = async (actionId: SourceControlActionId): Promise<void> => {
    const nextValue = actionRecipeDraftState.values[actionId]
=======
  const retireActionAgentDocument = (actionId: SourceControlActionId, agentId: unknown): void => {
    setActionRecipeDraftState((current) => {
      const value = current.values[actionId]
      if (!value.argumentChoices || value.argumentChoices.syntaxAgent === agentId) {
        return current
      }
      return {
        ...current,
        values: { ...current.values, [actionId]: demoteActionArgumentChoices(value) }
      }
    })
  }

  const saveActionTemplateDraft = async (actionId: SourceControlActionId): Promise<void> => {
    const submitted = storedDraftState.values[actionId]
    const { agentId: _binding, ...nextValue } = liftActionPermissionArgs(
      { ...actionRecipeDraftState.values[actionId], agentId: config.actions?.[actionId]?.agentId },
      true,
      actionId
    )
>>>>>>> upstream
    if (
      JSON.stringify(nextValue) === JSON.stringify(actionRecipeDraftState.baseValues[actionId]) ||
      savingActionRecipeIds[actionId]
    ) {
      return
    }
<<<<<<< fork
    setSavingActionRecipeIds((current) => ({ ...current, [actionId]: true }))
||||||| base
    setSavingActionTemplateIds((current) => ({ ...current, [actionId]: true }))
=======
    const textAction = SOURCE_CONTROL_TEXT_ACTION_IDS.find((id) => id === actionId)
    const { modelEdits, ...recipeValue } = nextValue
    const replayEdits = textAction && modelEdits?.length ? modelEdits : undefined
    let savedValue = recipeValue
    setSavingActionTemplateIds((current) => ({ ...current, [actionId]: true }))
>>>>>>> upstream
    try {
      await writeConfig((current) => {
        const choices: Partial<Record<string, SourceControlAiModelChoice>> =
          current.modelOverridesByOperation ?? {}
        // Menu edits replay against this write's settings and hosts; without them the saved model stays.
        const modelChoice =
          textAction && replayEdits
            ? replayGlobalTextModelEdits(current, textAction, replayEdits)
            : choices[actionId]
        savedValue = { ...recipeValue, modelChoice }
        return {
          ...(textAction && replayEdits
            ? {
                modelOverridesByOperation: {
                  ...current.modelOverridesByOperation,
                  [textAction]: modelChoice
                }
              }
            : {}),
          actions: setSourceControlActionDefault(current.actions, actionId, {
            commandInputTemplate: nextValue.commandInputTemplate,
<<<<<<< fork
            agentArgs: nextValue.agentArgs,
            launchOptions: nextValue.launchOptions
||||||| base
            agentArgs: nextValue.agentArgs
=======
            agentArgs: nextValue.agentArgs,
            launchPreferences: nextValue.launchPreferences,
            argumentChoices: nextValue.argumentChoices
>>>>>>> upstream
          })
        }
      })
      setActionRecipeDraftState((current) => ({
        values:
          JSON.stringify(current.values[actionId]) === JSON.stringify(submitted)
            ? { ...current.values, [actionId]: savedValue }
            : current.values,
        baseValues: { ...current.baseValues, [actionId]: savedValue }
      }))
    } finally {
      setSavingActionRecipeIds((current) => ({ ...current, [actionId]: false }))
    }
  }

  const discardActionRecipeDraft = (actionId: SourceControlActionId): void => {
    setActionRecipeDraftState((current) => ({
      ...current,
      values: {
        ...current.values,
        [actionId]: current.baseValues[actionId]
      }
    }))
  }

  const appendVariable = (actionId: SourceControlActionId, variable: string): void => {
    setActionRecipeDraftState((current) => {
      const currentTemplate = current.values[actionId].commandInputTemplate
      const separator = currentTemplate.endsWith('\n') || currentTemplate.length === 0 ? '' : ' '
      return {
        ...current,
        values: {
          ...current.values,
          [actionId]: {
            ...current.values[actionId],
            commandInputTemplate: `${currentTemplate}${separator}{${variable}}`
          }
        }
      }
    })
  }

  return {
    actionRecipeDraftState,
    savingActionRecipeIds,
    onActionTemplateChange,
    onActionAgentArgsChange,
<<<<<<< fork
    onActionLaunchOptionsChange,
    resetActionLaunchOptions,
    saveActionRecipeDraft,
    discardActionRecipeDraft,
||||||| base
    saveActionTemplateDraft,
    discardActionTemplateDraft,
=======
    onActionLaunchPreferencesChange,
    retireActionAgentDocument,
    onTextModelChoiceChange,
    saveActionTemplateDraft,
    discardActionTemplateDraft,
>>>>>>> upstream
    appendVariable
  }
}
