import {
  OBJECTIVE_CAPABILITY_KEYS,
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
  tier: ObjectiveTier
  landingBar: ObjectiveLandingBar
  maxConcurrency: number
  workspaceKind: ObjectiveWorkspaceKind | null
  writeTerritoryText: string
  capabilities: Record<ObjectiveCapability, CapabilityMode>
  roleAgents: Record<ObjectiveRole, string>
  sitterOverrides: Record<ObjectiveSitterCapability, CapabilityMode | 'inherit'>
  activeBudgetHours: number
  turns: string
  availableAgentIds: readonly string[]
}

export type ObjectiveEnrollmentErrorCode =
  | 'workspace-required'
  | 'objective-required'
  | 'objective-too-long'
  | 'landing-bar-requires-git'
  | 'max-concurrency-unsupported'
  | 'territory-required'
  | 'territory-too-many'
  | 'territory-duplicate'
  | 'territory-invalid'
  | 'capability-set-invalid'
  | 'role-agent-unknown'
  | 'active-budget-invalid'
  | 'turn-budget-invalid'

export type ObjectiveEnrollmentError = {
  code: ObjectiveEnrollmentErrorCode
  value?: string
}

export function parseWriteTerritory(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
}

export function territoryGlobError(glob: string): ObjectiveEnrollmentError | null {
  return isAllowedObjectiveTerritoryGlob(glob) ? null : { code: 'territory-invalid', value: glob }
}

export function isObjectiveLandingBarAvailable(
  workspaceKind: ObjectiveWorkspaceKind | null,
  landingBar: ObjectiveLandingBar
): boolean {
  return workspaceKind !== 'folder' || landingBar === 'files-on-disk'
}

export function validateObjectiveEnrollmentDraft(
  draft: ObjectiveEnrollmentDraft
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
  if (!isObjectiveLandingBarAvailable(draft.workspaceKind, draft.landingBar)) {
    errors.push({ code: 'landing-bar-requires-git' })
  }
  if (draft.maxConcurrency !== 1) {
    errors.push({ code: 'max-concurrency-unsupported' })
  }

  const territory = parseWriteTerritory(draft.writeTerritoryText)
  if (territory.length === 0) {
    errors.push({ code: 'territory-required' })
  } else if (territory.length > OBJECTIVE_TERRITORY_MAX_ENTRIES) {
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
