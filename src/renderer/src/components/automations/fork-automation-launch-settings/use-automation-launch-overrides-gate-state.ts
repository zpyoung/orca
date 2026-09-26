import { useMemo } from 'react'
import { getAutomationOwnerTarget, getAutomationTargetFromHostId } from '../automation-host-client'
import { buildAutomationRunContextForRepo } from '../automation-run-context'
import type { AutomationsPageDestinationState } from '../use-automations-page-destination-state'
import type { AutomationsPageLocalState } from '../use-automations-page-local-state'
import type { AutomationsPageStoreState } from '../use-automations-page-store-state'
import { useAutomationLaunchOverridesGate } from './useAutomationLaunchOverridesGate'
import type { AutomationLaunchOverridesGate } from './automation-launch-overrides-gate'

/** Track launch-override support for whichever host the open editor draft will save to. */
export function useAutomationLaunchOverridesGateState(args: {
  store: AutomationsPageStoreState
  local: AutomationsPageLocalState
  destination: AutomationsPageDestinationState
}): AutomationLaunchOverridesGate {
  const { repos, projectHostSetups } = args.store
  const { draft, editingAutomationId, automations, createOpen, createTarget } = args.local
  const { automationHostTarget } = args.destination

  const target = useMemo(() => {
    const editingAutomation = editingAutomationId
      ? (automations.find((automation) => automation.id === editingAutomationId) ?? null)
      : null
    if (editingAutomation) {
      return getAutomationOwnerTarget(editingAutomation, automationHostTarget)
    }
    const runContext = buildAutomationRunContextForRepo({
      repoId: draft.projectId,
      repos,
      projectHostSetups
    })
    return getAutomationTargetFromHostId(runContext?.hostId)
  }, [
    automationHostTarget,
    automations,
    draft.projectId,
    editingAutomationId,
    projectHostSetups,
    repos
  ])

  return useAutomationLaunchOverridesGate({
    open: createOpen && createTarget === 'orca',
    target
  })
}
