import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react'
import type {
  AgentLaunchOptionSelection,
  AgentLaunchOverrides
} from '../../../../../shared/fork-automation-launch-settings/agent-launch-overrides'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { agentLaunchOptionSelectionFromOverrides } from '../../settings/source-control-ai-action-recipe-draft'

/**
 * Hold a saved launch-option selection stable across renders. Callers resolve the
 * recipe inline and each resolve returns a fresh clone, so identity-keyed effects
 * would otherwise re-run — and reset the dialog draft — on every parent render.
 */
export function useStableAgentLaunchOptionSelection(
  value: AgentLaunchOptionSelection | null | undefined
): AgentLaunchOptionSelection | null {
  const key = JSON.stringify(value ?? null)
  return useMemo(() => JSON.parse(key) as AgentLaunchOptionSelection | null, [key])
}

/** Project the structured half of a draft override for save and launch payloads. */
export function useAgentLaunchOptionSelection(
  value: AgentLaunchOverrides
): AgentLaunchOptionSelection {
  return useMemo(() => agentLaunchOptionSelectionFromOverrides(value), [value])
}

/** Reset a planned source-control delivery whenever a launch recipe draft changes. */
export function useSourceControlAgentActionDraftEdits(args: {
  resetDeliveryPlan: () => void
  setSelectedAgent: Dispatch<SetStateAction<TuiAgent | null>>
  setLaunchOverrides: Dispatch<SetStateAction<AgentLaunchOverrides>>
  setCommandTemplate: Dispatch<SetStateAction<string>>
  setSaveLaunchRecipe: Dispatch<SetStateAction<boolean>>
}) {
  const {
    resetDeliveryPlan,
    setSelectedAgent,
    setLaunchOverrides,
    setCommandTemplate,
    setSaveLaunchRecipe
  } = args
  const resetPlanAfter = useCallback(
    <T>(apply: (value: T) => void) =>
      (value: T): void => {
        apply(value)
        resetDeliveryPlan()
      },
    [resetDeliveryPlan]
  )
  const onSelectedAgentChange = useCallback(
    (agent: TuiAgent | null): void => {
      setSelectedAgent(agent)
      setLaunchOverrides((current) => (current.agentArgs ? { agentArgs: current.agentArgs } : {}))
      resetDeliveryPlan()
    },
    [resetDeliveryPlan, setLaunchOverrides, setSelectedAgent]
  )
  const onLaunchOverridesChange = useCallback(
    (updater: (current: AgentLaunchOverrides) => AgentLaunchOverrides): void => {
      setLaunchOverrides(updater)
      resetDeliveryPlan()
    },
    [resetDeliveryPlan, setLaunchOverrides]
  )
  const onCommandTemplateChange = useMemo(
    () => resetPlanAfter(setCommandTemplate),
    [resetPlanAfter, setCommandTemplate]
  )
  const onSaveLaunchRecipeChange = useMemo(
    () => resetPlanAfter(setSaveLaunchRecipe),
    [resetPlanAfter, setSaveLaunchRecipe]
  )
  return {
    onSelectedAgentChange,
    onLaunchOverridesChange,
    onCommandTemplateChange,
    onSaveLaunchRecipeChange
  }
}
