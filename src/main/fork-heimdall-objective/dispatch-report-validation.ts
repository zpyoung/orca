import {
  createReportValidationProvenance,
  type ObjectiveFailureClass,
  type ReportValidationCode,
  type ReportValidationProvenance
} from '../../shared/fork-heimdall/effect-certainty'
import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import {
  ImplementerReportSchema,
  parseAndValidateImplementerReport,
  parseAndValidateIntegratorReport,
  parseAndValidatePlannerReport,
  parseAndValidateReviewerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'

export type ObjectiveDispatchAction = Extract<ObjectiveAction, { kind: `dispatch-${string}` }>

function dispatchedTaskKeys(ledger: WatcherLedger): string[] {
  const keys = new Set<string>()
  for (const attempt of getLatestAttempts(ledger)) {
    const action = ObjectiveActionSchema.safeParse(attempt.action)
    if (action.success && action.data.kind === 'dispatch-node') {
      keys.add(action.data.taskKey)
    }
  }
  return [...keys]
}

export function dispatchReportRole(
  action: ObjectiveDispatchAction
): ReportValidationProvenance['role'] {
  return action.kind === 'dispatch-planner'
    ? 'planner'
    : action.kind === 'dispatch-node'
      ? 'implementer'
      : action.kind === 'dispatch-reviewer'
        ? 'reviewer'
        : 'integrator'
}

type ResolvedDispatchReportValidation =
  | { ok: true }
  | { ok: false; reportValidation: ReportValidationProvenance }

export function validateResolvedDispatchReport(args: {
  action: ObjectiveDispatchAction
  dispatchId: string
  attemptFingerprint?: string
  reportPath: string
  report: unknown
  evidenceFiles: readonly string[]
  binding: ObjectiveSnapshotBinding
  objectiveStore: ObjectiveStore
  ledger: WatcherLedger
}): ResolvedDispatchReportValidation {
  const { action, report, binding, objectiveStore } = args
  const rejected = (
    code: ReportValidationCode,
    detail: string,
    reportedFiles: readonly string[] = args.evidenceFiles,
    observedFiles: readonly string[] = []
  ): ResolvedDispatchReportValidation => ({
    ok: false,
    reportValidation: createReportValidationProvenance({
      status: 'rejected',
      code,
      role: dispatchReportRole(action),
      dispatchId: args.dispatchId,
      ...(action.kind === 'dispatch-node' ? { taskKey: action.taskKey } : {}),
      reportPath: args.reportPath,
      detail,
      reportedFiles,
      observedFiles,
      hostVerifiable: true
    })
  })
  try {
    if (action.kind === 'dispatch-planner') {
      parseAndValidatePlannerReport(report, {
        writeTerritory: binding.contract.writeTerritory,
        dispatchedTaskKeys: dispatchedTaskKeys(args.ledger)
      })
      return { ok: true }
    }
    const plan = objectiveStore.getPlan(action.revisionId)
    if (!plan) {
      return rejected('semantic-invalid', `Plan ${action.revisionId} is unavailable`)
    }
    if (action.kind === 'dispatch-node') {
      const task =
        (args.attemptFingerprint
          ? objectiveStore.getDispatch(args.attemptFingerprint)?.task
          : undefined) ?? objectiveStore.getTask(action.revisionId, action.taskKey)
      if (!task) {
        return rejected('semantic-invalid', `Task ${action.taskKey} is unavailable`)
      }
      const parsed = parseAndValidateImplementerReport(
        report,
        task,
        binding.contract.writeTerritory
      )
      if (
        [...parsed.filesModified].sort().join('\0') !== [...args.evidenceFiles].sort().join('\0')
      ) {
        return rejected(
          'files-mismatch',
          'Report filesModified does not match worker completion evidence',
          parsed.filesModified,
          args.evidenceFiles
        )
      }
      return { ok: true }
    }
    if (action.kind === 'dispatch-reviewer') {
      parseAndValidateReviewerReport(report, plan)
    } else {
      parseAndValidateIntegratorReport(report, plan)
    }
    return { ok: true }
  } catch (error) {
    return rejected(
      'semantic-invalid',
      error instanceof Error ? error.message : 'Report semantic validation failed'
    )
  }
}

/** Only meaningful for a dispatch-node report; every other role has no per-criterion signal. */
export function classifyValidatedReportFailure(
  report: unknown,
  action: ObjectiveDispatchAction
): ObjectiveFailureClass {
  if (action.kind !== 'dispatch-node') {
    return 'criteria'
  }
  const parsed = ImplementerReportSchema.safeParse(report)
  if (!parsed.success) {
    return 'criteria'
  }
  const results = parsed.data.criteriaSelfAssessment.map((item) => item.result)
  if (results.some((result) => result === 'fail')) {
    return 'criteria'
  }
  return results.some((result) => result === 'unknown') ? 'environment' : 'criteria'
}
