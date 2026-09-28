import type { ObjectiveEnrollmentPayload } from './contract-types'
import {
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../fork-heimdall/capability'

/** Removes strict enrollment fields that a paired host has not advertised. */
export function adaptObjectiveEnrollmentToCapabilities(
  payload: ObjectiveEnrollmentPayload,
  capabilities: readonly string[]
): ObjectiveEnrollmentPayload {
  const supportsParallelExecution = capabilities.includes(
    HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
  )
  const supportsRoleLaunch = capabilities.includes(
    HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY
  )
  if (supportsParallelExecution && supportsRoleLaunch) {
    return payload
  }

  let adapted = payload
  if (!supportsParallelExecution) {
    const { lanesEnabled: _lanesEnabled, gates: _gates, ...legacyPayload } = adapted
    adapted = { ...legacyPayload, maxConcurrency: 1 }
  }
  if (!supportsRoleLaunch && adapted.roleLaunch !== undefined) {
    const { roleLaunch: _roleLaunch, ...legacyPayload } = adapted
    adapted = legacyPayload
  }
  return adapted
}
