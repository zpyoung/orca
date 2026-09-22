import type {
  ObjectiveEnrollmentPayload,
  ObjectiveRoleAgents,
  ObjectiveSitterOverrides
} from '../../../shared/fork-heimdall-objective/contract-types'
import type { EnrollInput } from '../../../shared/fork-heimdall/watcher-types'
import {
  watcherOwnerFromDraft,
  watcherOwnerInterventionCapability
} from '../fork-heimdall/watcher-owner-draft'
import {
  OBJECTIVE_ROLES,
  OBJECTIVE_SITTER_CAPABILITIES,
  parseWriteTerritory
} from './objective-enrollment-model'
import type { ObjectiveEnrollmentDraft } from './objective-enrollment-model'
import type { ObjectiveWorkspaceOption } from './objective-workspace-options'

export type ObjectiveEnrollmentSubmission = {
  input: EnrollInput
  owner: ObjectiveWorkspaceOption['owner']
}

export function buildObjectiveEnrollmentSubmission(
  draft: ObjectiveEnrollmentDraft,
  workspace: ObjectiveWorkspaceOption
): ObjectiveEnrollmentSubmission {
  const roleAgents: ObjectiveRoleAgents = {}
  for (const role of OBJECTIVE_ROLES) {
    if (draft.roleAgents[role]) {
      roleAgents[role] = draft.roleAgents[role]
    }
  }
  const sitterOverrides: ObjectiveSitterOverrides = {}
  for (const capability of OBJECTIVE_SITTER_CAPABILITIES) {
    const mode = draft.sitterOverrides[capability]
    if (mode !== 'inherit') {
      sitterOverrides[capability] = mode
    }
  }
  const existingPlan = draft.existingPlanText.trim()
  const parallelKindPayload: ObjectiveEnrollmentPayload = {
    objectiveText: draft.objectiveText.trim(),
    ...(existingPlan ? { existingPlan } : {}),
    tier: draft.tier,
    landingBar: draft.landingBar,
    lanesEnabled: draft.lanesEnabled,
    maxConcurrency: workspace.workspaceKind === 'folder' ? 1 : draft.maxConcurrency,
    workspaceKind: workspace.workspaceKind,
    writeTerritory: parseWriteTerritory(draft.writeTerritoryText),
    roleAgents,
    sitterOverrides
  }
  const kindPayload: EnrollInput['kindPayload'] =
    workspace.parallelExecutionSupported !== false
      ? parallelKindPayload
      : (() => {
          const { lanesEnabled: _lanesEnabled, ...legacyKindPayload } = parallelKindPayload
          return { ...legacyKindPayload, maxConcurrency: 1 }
        })()
  return {
    input: {
      kind: 'objective',
      repoId: workspace.repoId,
      worktreeId: workspace.worktreeId,
      capabilities: draft.capabilities,
      budget: {
        wallClockActiveMs: Math.round(draft.activeBudgetHours * 60 * 60 * 1_000),
        turns: Number(draft.turns)
      },
      kindPayload,
      owner: watcherOwnerFromDraft(draft.owner),
      ownerInterventionCapability: watcherOwnerInterventionCapability(draft.owner)
    },
    owner: workspace.owner
  }
}
