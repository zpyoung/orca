import {
  OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS,
  type ObjectiveEnrollmentRequest,
  type ObjectiveGate,
  type ObjectiveRoleAgents,
  type ObjectiveRoleLaunch,
  type ObjectiveRoleLaunchEntry,
  type ObjectiveSitterOverrides
} from '../../../shared/fork-heimdall-objective/contract-types'
import {
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../../shared/fork-heimdall/capability'
import { adaptObjectiveEnrollmentToCapabilities } from '../../../shared/fork-heimdall-objective/objective-enrollment-compatibility'
import type { EnrollInput } from '../../../shared/fork-heimdall/watcher-types'
import {
  watcherOwnerFromDraft,
  watcherOwnerInterventionCapability
} from '../fork-heimdall/watcher-owner-draft'
import {
  OBJECTIVE_ROLES,
  OBJECTIVE_SITTER_CAPABILITIES,
  effectiveNewWorktreeName,
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
  const baseBranch = draft.newWorktreeBaseBranch?.trim()
  const parallelKindPayload: ObjectiveEnrollmentRequest = {
    objectiveText: draft.objectiveText.trim(),
    ...(existingPlan ? { existingPlan } : {}),
    tier: draft.tier,
    landingBar: draft.landingBar,
    lanesEnabled: draft.lanesEnabled,
    maxConcurrency: workspace.workspaceKind === 'folder' ? 1 : draft.maxConcurrency,
    workspaceKind: workspace.workspaceKind,
    ...(workspace.createsWorktree
      ? {
          newWorktree: {
            name: effectiveNewWorktreeName(draft).trim(),
            ...(baseBranch ? { baseBranch } : {})
          }
        }
      : {}),
    writeTerritory: parseWriteTerritory(draft.writeTerritoryText),
    roleAgents,
    ...(roleLaunch ? { roleLaunch } : {}),
    sitterOverrides,
    ...(gates.length > 0 ? { gates } : {})
  }
  const capabilities: string[] = []
  const supportsUnprobedEnrollment = workspace.owner === undefined && !workspace.ownerUnavailable
  if (workspace.parallelExecutionSupported ?? supportsUnprobedEnrollment) {
    capabilities.push(HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY)
  }
  if (workspace.roleLaunchSupported ?? supportsUnprobedEnrollment) {
    capabilities.push(HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY)
  }
  const kindPayload = adaptObjectiveEnrollmentToCapabilities(parallelKindPayload, capabilities)
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
