import { z } from 'zod'
import { CapabilityModeSchema } from '../fork-heimdall/watcher-types'

export const OBJECTIVE_TEXT_MAX_LENGTH = 16_384
export const OBJECTIVE_EXISTING_PLAN_MAX_LENGTH = 65_536
export const OBJECTIVE_TERRITORY_MAX_ENTRIES = 64
export const OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB = '**'
export const OBJECTIVE_PATH_MAX_LENGTH = 1_024
export const OBJECTIVE_AGENT_ID_MAX_LENGTH = 256

const BoundedTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum)

export const ObjectiveTierSchema = z.enum(['express', 'standard', 'full'])
export type ObjectiveTier = z.infer<typeof ObjectiveTierSchema>

export const ObjectiveLandingBarSchema = z.enum([
  'files-on-disk',
  'committed-local-branch',
  'pushed-ref',
  'hosted-review',
  'merged'
])
export type ObjectiveLandingBar = z.infer<typeof ObjectiveLandingBarSchema>

export const ObjectiveWorkspaceKindSchema = z.enum(['git', 'folder'])
export type ObjectiveWorkspaceKind = z.infer<typeof ObjectiveWorkspaceKindSchema>

export const ObjectiveRoleSchema = z.enum(['planner', 'implementer', 'reviewer', 'integrator'])
export type ObjectiveRole = z.infer<typeof ObjectiveRoleSchema>

export const OBJECTIVE_ROLES = ObjectiveRoleSchema.options
export const OBJECTIVE_CAPABILITY_KEYS = ['plan', 'implement', 'review', 'check', 'land'] as const
export type ObjectiveCapabilityKey = (typeof OBJECTIVE_CAPABILITY_KEYS)[number]
export const ObjectiveCapabilitiesSchema = z
  .object({
    plan: CapabilityModeSchema,
    implement: CapabilityModeSchema,
    review: CapabilityModeSchema,
    check: CapabilityModeSchema,
    land: CapabilityModeSchema
  })
  .strict()
export type ObjectiveCapabilities = z.infer<typeof ObjectiveCapabilitiesSchema>

export const ObjectiveRoleAgentsSchema = z
  .object({
    planner: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional(),
    implementer: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional(),
    reviewer: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional(),
    integrator: BoundedTextSchema(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional()
  })
  .strict()
export type ObjectiveRoleAgents = z.infer<typeof ObjectiveRoleAgentsSchema>

export const ObjectiveSitterOverridesSchema = z
  .object({
    updateBranch: CapabilityModeSchema.optional(),
    resolveConflicts: CapabilityModeSchema.optional(),
    fixChecks: CapabilityModeSchema.optional(),
    merge: CapabilityModeSchema.optional()
  })
  .strict()
export type ObjectiveSitterOverrides = z.infer<typeof ObjectiveSitterOverridesSchema>

function wildcardMatches(value: string, pattern: string): boolean {
  let expression = '^'
  for (const character of pattern) {
    if (character === '*') {
      expression += '.*'
    } else if (character === '?') {
      expression += '.'
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${expression}$`, 'u').test(value)
}

function hasPathControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) {
      return true
    }
  }
  return false
}

export function isWorkspaceRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > OBJECTIVE_PATH_MAX_LENGTH ||
    value !== value.trim() ||
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.includes('\\') ||
    hasPathControlCharacter(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false
  }
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}
export function isObjectiveConcreteWorkspacePath(value: string): boolean {
  if (!isWorkspaceRelativePath(value) || /[*?[\]{}()!]/u.test(value)) {
    return false
  }
  const root = value.split('/', 1)[0]
  return root !== '.git' && root !== '.orca'
}

export const ObjectiveWorkspacePathSchema = z
  .string()
  .max(OBJECTIVE_PATH_MAX_LENGTH)
  .refine(isObjectiveConcreteWorkspacePath, 'Path must be a concrete workspace-relative path')

export function isAllowedObjectiveTerritoryGlob(value: string): boolean {
  if (!isWorkspaceRelativePath(value) || /[[\]{}()!]/u.test(value)) {
    return false
  }
  if (value === OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB) {
    return true
  }
  const slash = value.indexOf('/')
  const root = slash === -1 ? value : value.slice(0, slash)
  return !wildcardMatches('.git', root) && !wildcardMatches('.orca', root)
}

export const ObjectiveTerritoryGlobSchema = z
  .string()
  .max(OBJECTIVE_PATH_MAX_LENGTH)
  .refine(
    isAllowedObjectiveTerritoryGlob,
    'Territory must be ** or a bounded workspace-relative glob that excludes .git and .orca'
  )

export const ObjectiveEnrollmentPayloadSchema = z
  .object({
    objectiveText: BoundedTextSchema(OBJECTIVE_TEXT_MAX_LENGTH),
    existingPlan: BoundedTextSchema(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH).optional(),
    tier: ObjectiveTierSchema,
    landingBar: ObjectiveLandingBarSchema,
    maxConcurrency: z.number().int().min(1).max(1_024),
    workspaceKind: ObjectiveWorkspaceKindSchema,
    writeTerritory: z
      .array(ObjectiveTerritoryGlobSchema)
      .min(1)
      .max(OBJECTIVE_TERRITORY_MAX_ENTRIES)
      .refine((values) => new Set(values).size === values.length, 'Territory globs must be unique'),
    roleAgents: ObjectiveRoleAgentsSchema,
    sitterOverrides: ObjectiveSitterOverridesSchema
  })
  .strict()
export type ObjectiveEnrollmentPayload = z.infer<typeof ObjectiveEnrollmentPayloadSchema>

export const objectiveEnrollmentPayloadSchema = ObjectiveEnrollmentPayloadSchema

export function objectiveCapabilityModes(landingBar: ObjectiveLandingBar): ObjectiveCapabilities {
  return {
    plan: 'gated',
    implement: 'on',
    review: 'on',
    check: 'on',
    land: landingBar === 'files-on-disk' ? 'on' : 'gated'
  }
}
