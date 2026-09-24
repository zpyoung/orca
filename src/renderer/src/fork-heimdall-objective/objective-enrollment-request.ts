import {
  OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS,
  type ObjectiveEnrollmentPayload,
  type ObjectiveGate,
  type ObjectiveRoleAgents,
  type ObjectiveRoleLaunch,
  type ObjectiveRoleLaunchEntry,
  type ObjectiveSitterOverrides
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

function buildRoleLaunch(
  roleLaunch: ObjectiveEnrollmentDraft['roleLaunch']
): ObjectiveRoleLaunch | undefined {
  if (!roleLaunch) {
    return undefined
  }
  const result: ObjectiveRoleLaunch = {}
  for (const role of OBJECTIVE_ROLES) {
    const draftEntry = roleLaunch[role]
    if (!draftEntry) {
      continue
    }
    const model = draftEntry.model.trim()
    const entry: ObjectiveRoleLaunchEntry = {
      ...(model ? { model } : {}),
      ...(draftEntry.effort ? { effort: draftEntry.effort } : {})
    }
    if (Object.keys(entry).length > 0) {
      result[role] = entry
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
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
  const roleLaunch = buildRoleLaunch(draft.roleLaunch)
  const gates: ObjectiveGate[] = draft.gates.map((gateDraft) => ({
    name: gateDraft.name.trim(),
    command: gateDraft.command.trim(),
    timeoutSeconds: gateDraft.timeoutSecondsText.trim()
      ? Number(gateDraft.timeoutSecondsText)
      : OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS
  }))
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
    ...(roleLaunch ? { roleLaunch } : {}),
    sitterOverrides,
    ...(gates.length > 0 ? { gates } : {})
  }
  const kindPayload: EnrollInput['kindPayload'] =
    workspace.parallelExecutionSupported !== false
      ? parallelKindPayload
      : (() => {
          const {
            lanesEnabled: _lanesEnabled,
            gates: _gates,
            ...legacyKindPayload
          } = parallelKindPayload
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
