import {
  OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB,
  OBJECTIVE_CAPABILITY_KEYS,
  OBJECTIVE_EXISTING_PLAN_MAX_LENGTH,
  OBJECTIVE_ROLES as SHARED_OBJECTIVE_ROLES,
  OBJECTIVE_TERRITORY_MAX_ENTRIES,
  OBJECTIVE_TEXT_MAX_LENGTH,
  ObjectiveLandingBarSchema,
  ObjectiveTierSchema,
  isAllowedObjectiveTerritoryGlob,
  type ObjectiveLandingBar,
  type ObjectiveRole,
  type ObjectiveTier,
  type ObjectiveWorkspaceKind
} from '../../../shared/fork-heimdall-objective/contract-types'
import type { CapabilityMode } from '../../../shared/fork-heimdall/watcher-types'
import type { WatcherOwnerDraft } from '../fork-heimdall/watcher-owner-draft'

export const OBJECTIVE_TIERS = ObjectiveTierSchema.options
export type { ObjectiveTier }

export const OBJECTIVE_LANDING_BARS = ObjectiveLandingBarSchema.options
export type { ObjectiveLandingBar }

export const OBJECTIVE_CAPABILITIES = OBJECTIVE_CAPABILITY_KEYS
export type ObjectiveCapability = (typeof OBJECTIVE_CAPABILITIES)[number]

export const OBJECTIVE_ROLES = SHARED_OBJECTIVE_ROLES
export type { ObjectiveRole }

export const OBJECTIVE_SITTER_CAPABILITIES = [
  'updateBranch',
  'resolveConflicts',
  'fixChecks',
  'merge'
] as const
export type ObjectiveSitterCapability = (typeof OBJECTIVE_SITTER_CAPABILITIES)[number]

export type ObjectiveEnrollmentDraft = {
  objectiveText: string
  existingPlanText: string
  tier: ObjectiveTier
  landingBar: ObjectiveLandingBar
  maxConcurrency: number
  lanesEnabled: boolean
  workspaceKind: ObjectiveWorkspaceKind | null
  writeTerritoryText: string
  capabilities: Record<ObjectiveCapability, CapabilityMode>
  roleAgents: Record<ObjectiveRole, string>
  sitterOverrides: Record<ObjectiveSitterCapability, CapabilityMode | 'inherit'>
  activeBudgetHours: number
  turns: string
  availableAgentIds: readonly string[]
  owner: WatcherOwnerDraft
}

export type ObjectiveLandingBarAvailability = {
  workspaceKind: ObjectiveWorkspaceKind | null
  worktreeId: string | null
}

export type ObjectiveEnrollmentErrorCode =
  | 'workspace-required'
  | 'objective-required'
  | 'objective-too-long'
  | 'existing-plan-too-long'
  | 'landing-bar-requires-git'
  | 'landing-bar-requires-worktree'
  | 'max-concurrency-invalid'
  | 'territory-too-many'
  | 'territory-duplicate'
  | 'territory-invalid'
  | 'capability-set-invalid'
  | 'plan-off-requires-approved-plan'
  | 'role-agent-unknown'
  | 'active-budget-invalid'
  | 'turn-budget-invalid'

export type ObjectiveEnrollmentError = {
  code: ObjectiveEnrollmentErrorCode
  value?: string
}

export function parseWriteTerritory(value: string): string[] {
  const territory = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  return territory.length === 0 ? [OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB] : territory
}

export function territoryGlobError(glob: string): ObjectiveEnrollmentError | null {
  return isAllowedObjectiveTerritoryGlob(glob) ? null : { code: 'territory-invalid', value: glob }
}

export function isObjectiveLandingBarAvailable(
  availability: ObjectiveLandingBarAvailability,
  landingBar: ObjectiveLandingBar
): boolean {
  if (availability.workspaceKind === 'folder') {
    return landingBar === 'files-on-disk'
  }
  if (landingBar !== 'hosted-review' && landingBar !== 'merged') {
    return true
  }
  return availability.worktreeId !== null
}

export function validateObjectiveEnrollmentDraft(
  draft: ObjectiveEnrollmentDraft,
  landingAvailability: ObjectiveLandingBarAvailability
): ObjectiveEnrollmentError[] {
  const errors: ObjectiveEnrollmentError[] = []
  const objective = draft.objectiveText.trim()
  if (!draft.workspaceKind) {
    errors.push({ code: 'workspace-required' })
  }
  if (!objective) {
    errors.push({ code: 'objective-required' })
  } else if (objective.length > OBJECTIVE_TEXT_MAX_LENGTH) {
    errors.push({ code: 'objective-too-long' })
  }
  if (draft.existingPlanText.trim().length > OBJECTIVE_EXISTING_PLAN_MAX_LENGTH) {
    errors.push({ code: 'existing-plan-too-long' })
  }
  if (
    landingAvailability.workspaceKind !== null &&
    !isObjectiveLandingBarAvailable(landingAvailability, draft.landingBar)
  ) {
    errors.push({
      code:
        landingAvailability.workspaceKind === 'folder'
          ? 'landing-bar-requires-git'
          : 'landing-bar-requires-worktree'
    })
  }
  if (
    !Number.isInteger(draft.maxConcurrency) ||
    draft.maxConcurrency < 1 ||
    draft.maxConcurrency > 1_024
  ) {
    errors.push({ code: 'max-concurrency-invalid' })
  }

  const territory = parseWriteTerritory(draft.writeTerritoryText)
  if (territory.length > OBJECTIVE_TERRITORY_MAX_ENTRIES) {
    errors.push({ code: 'territory-too-many' })
  } else {
    if (new Set(territory).size !== territory.length) {
      errors.push({ code: 'territory-duplicate' })
    }
    const invalidTerritory = territory.map(territoryGlobError).find(Boolean)
    if (invalidTerritory) {
      errors.push(invalidTerritory)
    }
  }

  const capabilityKeys = Object.keys(draft.capabilities).sort()
  if (
    capabilityKeys.length !== OBJECTIVE_CAPABILITIES.length ||
    !OBJECTIVE_CAPABILITIES.every((key) => capabilityKeys.includes(key))
  ) {
    errors.push({ code: 'capability-set-invalid' })
  }
  if (draft.capabilities.plan === 'off') {
    errors.push({ code: 'plan-off-requires-approved-plan' })
  }
  const availableAgents = new Set(draft.availableAgentIds)
  for (const role of OBJECTIVE_ROLES) {
    const agentId = draft.roleAgents[role]
    if (agentId && !availableAgents.has(agentId)) {
      errors.push({ code: 'role-agent-unknown', value: agentId })
      break
    }
  }
  if (!Number.isFinite(draft.activeBudgetHours) || draft.activeBudgetHours <= 0) {
    errors.push({ code: 'active-budget-invalid' })
  }
  const turns = Number(draft.turns)
  if (!draft.turns.trim() || !Number.isInteger(turns) || turns < 0) {
    errors.push({ code: 'turn-budget-invalid' })
  }
  return errors
}
