import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { CapabilityModeSchema, type WatcherKindId } from '../../shared/fork-heimdall/watcher-types'
import { OWNER_INTERVENTION_CAPABILITY } from '../../shared/fork-heimdall/owner/owner-capability'
import {
  OBJECTIVE_CAPABILITY_KEYS,
  OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS,
  ObjectiveGateSchema
} from '../../shared/fork-heimdall-objective/contract-types'
import { REPEATED_FLAG_SEPARATOR } from '../args'
import { getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { parseHeimdallCreateSchema } from './create-input-validation'
import { hoursToMilliseconds } from './watcher-command-values'

const HOSTED_REVIEW_CAPABILITY_KEYS: Record<string, true> = {
  updateBranch: true,
  resolveConflicts: true,
  fixChecks: true,
  merge: true
}
export const HeimdallHostedReviewCapabilitiesSchema = z
  .object({
    updateBranch: CapabilityModeSchema,
    resolveConflicts: CapabilityModeSchema,
    fixChecks: CapabilityModeSchema,
    merge: CapabilityModeSchema
  })
  .strict()

function valueFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
  return flags.has(name) ? getRequiredStringFlag(flags, name) : undefined
}
function repeatedCreateValues(flags: Map<string, string | boolean>, name: string): string[] {
  if (!flags.has(name)) {
    return []
  }
  const values = getRequiredStringFlag(flags, name).split(REPEATED_FLAG_SEPARATOR)
  if (values.some((value) => value.length === 0)) {
    throw new RuntimeClientError('invalid_argument', `--${name} requires a non-empty value.`)
  }
  return values
}

function readTextFlag(
  flags: Map<string, string | boolean>,
  name: string,
  cwd: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const path = getRequiredStringFlag(flags, name)
  const resolved = isAbsolute(path) ? path : join(cwd, path)
  try {
    return readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Could not read --${name} file at ${resolved}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function parseHours(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === 'none') {
    return null
  }
  const milliseconds = hoursToMilliseconds(value)
  if (milliseconds === undefined || milliseconds <= 0) {
    throw new RuntimeClientError('invalid_argument', '--hours must be a positive number or none.')
  }
  return milliseconds
}

function parseTurns(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === 'none') {
    return null
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--turns must be a positive whole number or none.'
    )
  }
  const turns = Number(value)
  if (!Number.isSafeInteger(turns)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--turns must be a positive safe integer or none.'
    )
  }
  return turns
}

export function buildHeimdallCreateFlagOverrides(
  flags: Map<string, string | boolean>,
  cwd: string,
  kind: WatcherKindId
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  const payload: Record<string, unknown> = {}
  if (kind === 'objective') {
    const objective = valueFlag(flags, 'objective')
    const objectiveFile = readTextFlag(flags, 'objective-file', cwd)
    if (objective !== undefined && objectiveFile !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose either --objective or --objective-file, not both.'
      )
    }
    if (objective !== undefined || objectiveFile !== undefined) {
      payload.objectiveText = objective ?? objectiveFile
    }
    const planFile = readTextFlag(flags, 'plan-file', cwd)
    if (planFile !== undefined) {
      payload.existingPlan = planFile
    }
    for (const [flag, field] of [
      ['tier', 'tier'],
      ['landing-bar', 'landingBar'],
      ['max-concurrency', 'maxConcurrency']
    ]) {
      const value = valueFlag(flags, flag)
      if (value !== undefined) {
        payload[field] = field === 'maxConcurrency' ? Number(value) : value
      }
    }
    if (flags.has('no-lanes')) {
      if (flags.get('no-lanes') !== true) {
        throw new RuntimeClientError(
          'invalid_argument',
          '--no-lanes is a bare switch and takes no value.'
        )
      }
      payload.lanesEnabled = false
    }
    const territories = repeatedCreateValues(flags, 'territory')
    if (territories.length > 0) {
      payload.writeTerritory = territories
    }
    const roleAgents: Record<string, unknown> = {}
    for (const assignment of repeatedCreateValues(flags, 'role-agent')) {
      const separator = assignment.indexOf('=')
      if (separator <= 0 || separator === assignment.length - 1) {
        throw new RuntimeClientError('invalid_argument', '--role-agent must be <role>=<agent>.')
      }
      roleAgents[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    }
    if (Object.keys(roleAgents).length > 0) {
      payload.roleAgents = roleAgents
    }
    const gates = repeatedCreateValues(flags, 'gate')
    if (gates.length > 0) {
      payload.gates = gates.map((assignment, index) => {
        const separator = assignment.indexOf('=')
        if (separator <= 0 || separator === assignment.length - 1) {
          throw new RuntimeClientError('invalid_argument', '--gate must be <name>=<command>.')
        }
        return parseHeimdallCreateSchema(
          ObjectiveGateSchema,
          {
            name: assignment.slice(0, separator),
            command: assignment.slice(separator + 1),
            timeoutSeconds: OBJECTIVE_GATE_DEFAULT_TIMEOUT_SECONDS
          },
          `--gate[${index + 1}]`
        )
      })
    }
  } else {
    for (const [flag, field] of [
      ['branch-update', 'branchUpdateMode'],
      ['merge-method', 'mergeMethod']
    ]) {
      const value = valueFlag(flags, flag)
      if (value !== undefined) {
        payload[field] = field === 'mergeMethod' && value === 'default' ? null : value
      }
    }
  }
  if (Object.keys(payload).length > 0) {
    overrides.kindPayload = payload
  }

  const capabilities: Record<string, unknown> = {}
  for (const [index, assignment] of repeatedCreateValues(flags, 'cap').entries()) {
    const separator = assignment.indexOf('=')
    if (separator <= 0 || separator === assignment.length - 1) {
      throw new RuntimeClientError('invalid_argument', '--cap must be <key>=<off|gated|on>.')
    }
    const key = assignment.slice(0, separator)
    const mode = assignment.slice(separator + 1)
    if (!CapabilityModeSchema.safeParse(mode).success) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--cap[${index + 1}]: invalid mode for ${key}; use off, gated, or on.`
      )
    }
    if (key === OWNER_INTERVENTION_CAPABILITY) {
      overrides.ownerInterventionCapability = mode
      continue
    }
    const valid =
      kind === 'objective'
        ? OBJECTIVE_CAPABILITY_KEYS.some((candidate) => candidate === key)
        : Object.hasOwn(HOSTED_REVIEW_CAPABILITY_KEYS, key)
    if (!valid) {
      const keys =
        kind === 'objective'
          ? `${OBJECTIVE_CAPABILITY_KEYS.join(', ')}, ${OWNER_INTERVENTION_CAPABILITY}`
          : `${Object.keys(HOSTED_REVIEW_CAPABILITY_KEYS).join(', ')}, ${OWNER_INTERVENTION_CAPABILITY}`
      throw new RuntimeClientError(
        'invalid_argument',
        `--cap[${index + 1}]: unknown ${kind} capability "${key}". Use: ${keys}.`
      )
    }
    capabilities[key] = mode
  }
  if (Object.keys(capabilities).length > 0) {
    overrides.capabilities = capabilities
  }

  const hours = parseHours(valueFlag(flags, 'hours'))
  const turns = parseTurns(valueFlag(flags, 'turns'))
  if (hours !== undefined || turns !== undefined) {
    overrides.budget = {
      ...(hours === undefined ? {} : { wallClockActiveMs: hours }),
      ...(turns === undefined ? {} : { turns })
    }
  }
  const owner = valueFlag(flags, 'owner')
  const ownerModel = valueFlag(flags, 'owner-model')
  const ownerEffort = valueFlag(flags, 'owner-effort')
  if (owner !== undefined && owner !== 'claude') {
    throw new RuntimeClientError('invalid_argument', '--owner currently supports only claude.')
  }
  if (owner !== undefined || ownerModel !== undefined || ownerEffort !== undefined) {
    overrides.owner = {
      ...(owner === undefined ? {} : { agent: owner }),
      ...(ownerModel === undefined ? {} : { model: ownerModel }),
      ...(ownerEffort === undefined ? {} : { effort: ownerEffort })
    }
  }
  return overrides
}
