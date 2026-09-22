import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { ImplementerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { createObjectiveNodeCommit, runObjectiveConflictChecks } from './merge-train-git'
import type { ObjectiveStore } from './objective-store'

export type QueueObjectiveDispatchReportResult =
  | { kind: 'queued'; record: ObjectiveDispatchRecord }
  | { kind: 'conflict-context-missing'; dispatchId: string }
  | { kind: 'dispatch-not-queueable'; state: ObjectiveDispatchRecord['state'] }
  | {
      kind: 'conflict-checks-failed'
      command: string
      exitCode: number | null
      timedOut: boolean
      checkedTaskKeys: string[]
    }

/** Resumes durable report normalization and queues the node only after required conflict checks. */
export async function queueObjectiveDispatchReport(args: {
  record: ObjectiveDispatchRecord
  target: ObjectiveWorkspaceTarget
  objectiveStore: ObjectiveStore
  lease: LeaseGuard
  reportPath: string | null
  report: ImplementerReport
  reportDigest: string
  completedAtMs: number
  allowFailed?: boolean
}): Promise<QueueObjectiveDispatchReportResult> {
  if (
    args.record.state !== 'running' &&
    args.record.state !== 'resolving-conflict' &&
    !(args.allowFailed === true && args.record.state === 'failed')
  ) {
    return { kind: 'dispatch-not-queueable', state: args.record.state }
  }
  if (args.record.reportDigest !== null && args.record.reportDigest !== args.reportDigest) {
    throw new Error('Durable dispatch report checkpoint has a different digest')
  }
  const validatedRecord: ObjectiveDispatchRecord = {
    ...args.record,
    reportPath: args.reportPath,
    report: args.report,
    reportDigest: args.reportDigest,
    completedAtMs: args.completedAtMs
  }
  await args.lease.assertHeld()
  args.objectiveStore.saveDispatch(validatedRecord)

  const commitSha =
    validatedRecord.commitSha ??
    (
      await createObjectiveNodeCommit(
        args.target,
        {
          baseCommit: args.record.baseCommit,
          reportedPaths: args.report.filesModified,
          taskKey: args.record.taskKey,
          title: args.record.task.title
        },
        args.lease
      )
    ).commitSha
  const committedRecord: ObjectiveDispatchRecord = { ...validatedRecord, commitSha }
  await args.lease.assertHeld()
  args.objectiveStore.saveDispatch(committedRecord)

  if (args.record.state === 'resolving-conflict') {
    const conflictingRecords: ObjectiveDispatchRecord[] = []
    for (const dispatchId of new Set(args.record.conflictingDispatchIds)) {
      const candidate = args.objectiveStore.dispatchForId(args.record.watcherId, dispatchId)
      if (
        !candidate ||
        candidate.revisionId !== args.record.revisionId ||
        candidate.state !== 'applied' ||
        candidate.report === null
      ) {
        return { kind: 'conflict-context-missing', dispatchId }
      }
      conflictingRecords.push(candidate)
    }
    const commands = [committedRecord, ...conflictingRecords].flatMap((record) =>
      record.task.criteria.flatMap((criterion) =>
        criterion.shellCheckable && criterion.checkCommand ? [criterion.checkCommand] : []
      )
    )
    const checks = await runObjectiveConflictChecks(args.target, commands, args.lease)
    if (checks.kind === 'failed') {
      return {
        kind: 'conflict-checks-failed',
        command: checks.firstFailure.command,
        exitCode: checks.firstFailure.exitCode,
        timedOut: checks.firstFailure.timedOut,
        checkedTaskKeys: [
          committedRecord.taskKey,
          ...conflictingRecords.map((record) => record.taskKey)
        ]
      }
    }
  }
  const queued = { ...committedRecord, state: 'waiting-to-apply' as const }
  await args.lease.assertHeld()
  args.objectiveStore.saveDispatch(queued)
  return { kind: 'queued', record: queued }
}
