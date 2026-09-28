import type {
  ObjectiveEnrollmentPayload,
  ObjectiveRole
} from '../../shared/fork-heimdall-objective/contract-types'

/**
 * Resolves the model/effort a dispatched role's worker should launch with. A role with no
 * `roleLaunch` entry, or an entry with the field unset, omits that field so the dispatched worker
 * launches with the agent CLI's own default.
 */
export function resolveObjectiveRoleLaunch(
  contract: Pick<ObjectiveEnrollmentPayload, 'roleLaunch'>,
  role: ObjectiveRole
): { model?: string; effort?: string } {
  const launch = contract.roleLaunch?.[role]
  return {
    ...(launch?.model === undefined ? {} : { model: launch.model }),
    ...(launch?.effort === undefined ? {} : { effort: launch.effort })
  }
}
