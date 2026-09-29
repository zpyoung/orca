import { RuntimeClientError } from '../runtime-client'
import { isPlainObject } from '../../shared/fork-ask-question-tool/ask-question-field-validation'
import { readAskSpecInput } from '../fork-ask-question-tool/ask-cli-flags'
import { OWNER_INTERVENTION_CAPABILITY } from '../../shared/fork-heimdall/owner/owner-capability'
import {
  ObjectiveLandingBarSchema,
  objectiveCapabilityModes,
  type ObjectiveLandingBar
} from '../../shared/fork-heimdall-objective/contract-types'
import type { WatcherKindId } from '../../shared/fork-heimdall/watcher-types'

const ROOT_SPEC_KEYS: Record<string, true> = {
  kindPayload: true,
  capabilities: true,
  budget: true,
  owner: true,
  ownerInterventionCapability: true
}
const OBJECTIVE_PAYLOAD_KEYS: Record<string, true> = {
  objectiveText: true,
  existingPlan: true,
  tier: true,
  landingBar: true,
  lanesEnabled: true,
  maxConcurrency: true,
  writeTerritory: true,
  roleAgents: true,
  roleLaunch: true,
  sitterOverrides: true,
  gates: true
}
const HOSTED_REVIEW_PAYLOAD_KEYS: Record<string, true> = {
  branch: true,
  provider: true,
  reviewNumber: true,
  reviewUrl: true,
  branchUpdateMode: true,
  mergeMethod: true,
  mergeCheckScope: true
}

function mergeDeep(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return overlay === undefined ? base : overlay
  }
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    Object.defineProperty(result, key, {
      value: mergeDeep(result[key], value),
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

function readSpec(
  flags: Map<string, string | boolean>,
  cwd: string,
  kind: WatcherKindId
): Record<string, unknown> {
  if (!flags.has('spec')) {
    return {}
  }
  const value = readAskSpecInput(flags, cwd)
  if (!isPlainObject(value)) {
    throw new RuntimeClientError('invalid_argument', '--spec must contain a JSON object.')
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(ROOT_SPEC_KEYS, key)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `spec.${key}: is not supported; choose the workspace with --worktree and put kind fields under kindPayload.`
      )
    }
  }
  if (value.kindPayload !== undefined) {
    if (!isPlainObject(value.kindPayload)) {
      throw new RuntimeClientError('invalid_argument', 'spec.kindPayload: must be a JSON object.')
    }
    const allowed = kind === 'objective' ? OBJECTIVE_PAYLOAD_KEYS : HOSTED_REVIEW_PAYLOAD_KEYS
    for (const key of Object.keys(value.kindPayload)) {
      if (!Object.hasOwn(allowed, key)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `spec.kindPayload.${key}: is not a supported ${kind} field.`
        )
      }
    }
  }
  const result: Record<string, unknown> = { ...value }
  if (
    isPlainObject(value.capabilities) &&
    Object.hasOwn(value.capabilities, OWNER_INTERVENTION_CAPABILITY)
  ) {
    if (result.ownerInterventionCapability !== undefined) {
      throw new RuntimeClientError(
        'invalid_argument',
        `spec.capabilities.${OWNER_INTERVENTION_CAPABILITY}: use only one owner-intervention setting.`
      )
    }
    const capabilities = { ...value.capabilities }
    result.ownerInterventionCapability = capabilities[OWNER_INTERVENTION_CAPABILITY]
    delete capabilities[OWNER_INTERVENTION_CAPABILITY]
    result.capabilities = capabilities
  }
  return result
}

function defaults(
  kind: WatcherKindId,
  objectiveLandingBar: ObjectiveLandingBar = 'files-on-disk'
): Record<string, unknown> {
  const budget = { wallClockActiveMs: 14_400_000, turns: kind === 'objective' ? 40 : null }
  if (kind === 'objective') {
    return {
      capabilities: objectiveCapabilityModes(objectiveLandingBar),
      budget,
      kindPayload: {
        objectiveText: '',
        tier: 'standard',
        landingBar: 'files-on-disk',
        lanesEnabled: true,
        maxConcurrency: 3,
        workspaceKind: 'git',
        writeTerritory: ['**'],
        roleAgents: {},
        sitterOverrides: {}
      }
    }
  }
  return {
    capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'off' },
    budget,
    kindPayload: { branchUpdateMode: 'merge-base-update', mergeMethod: null }
  }
}

export function mergeHeimdallCreateSpec(
  kind: WatcherKindId,
  flags: Map<string, string | boolean>,
  cwd: string,
  explicitOverrides: Record<string, unknown>
): unknown {
  const spec = readSpec(flags, cwd, kind)
  let landingBar: ObjectiveLandingBar = 'files-on-disk'
  if (kind === 'objective') {
    const candidatePayload = mergeDeep(
      mergeDeep(defaults(kind).kindPayload, spec.kindPayload),
      explicitOverrides.kindPayload
    )
    if (isPlainObject(candidatePayload)) {
      const parsed = ObjectiveLandingBarSchema.safeParse(candidatePayload.landingBar)
      if (parsed.success) {
        landingBar = parsed.data
      }
    }
  }
  return mergeDeep(mergeDeep(defaults(kind, landingBar), spec), explicitOverrides)
}
