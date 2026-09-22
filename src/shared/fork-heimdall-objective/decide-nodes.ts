import { deriveBudgetState } from '../fork-heimdall/budget'
import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import { objectiveRetryExhaustedDeviation } from './deviation-context'
import {
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  objectiveAttemptFailureClass,
  objectiveInFlightTaskKeys,
  objectiveNoAction,
  objectiveNodeRetryCount,
  objectiveRetryableFailure,
  OBJECTIVE_INFRA_REDISPATCH_CAP,
  type ObjectiveAttempt,
  type ObjectiveDecisionOutcome
} from './decision-context'
import type {
  ObjectivePendingReport,
  ObjectiveRevisionProjection,
  ObjectiveWorld
} from './detail-types'
import {
  decideObjectiveNodeFailure,
  decideObjectiveReportRejection,
  projectedObjectiveReportRejection,
  rejectedObjectiveReportResult
} from './node-failure-context'
import {
  objectiveExclusiveRoleInFlight,
  objectiveParallelSlotState,
  objectivePausedDispatchRetry,
  objectiveRemainingChainLengths,
  prioritizeReadyObjectiveTaskKeys
} from './parallel-scheduling'

export function decideObjectiveNodes(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection,
  ownerConfigured = false
): ObjectiveDecisionOutcome | null {
  const nodes = snapshot.world.plan.nodes.filter((node) => node.revisionId === revision.id)
  const byKey = new Map(nodes.map((node) => [node.taskKey, node]))
  const planOrder = new Map(nodes.map((node, index) => [node.taskKey, index]))
  const failureOutcomes: ObjectiveDecisionOutcome[] = []
  const inFlightTaskKeys = objectiveInFlightTaskKeys(ledger, revision.id)
  const unavailableTaskKeys = new Set(inFlightTaskKeys)
  const retryByTaskKey = new Map<string, ObjectiveDecisionOutcome>()
  const activeTaskKeys = new Set(inFlightTaskKeys)
  const failedTaskKeys = new Set<string>()
  const projectedDispatches = snapshot.world.parallel?.dispatches ?? []
  for (const dispatch of projectedDispatches) {
    if (
      dispatch.revisionId === revision.id &&
      (dispatch.state === 'running' ||
        dispatch.state === 'waiting-to-apply' ||
        dispatch.state === 'applying' ||
        dispatch.state === 'resolving-conflict')
    ) {
      activeTaskKeys.add(dispatch.taskKey)
    }
  }
  const failureContext = { snapshot, ledger, attempts, reports, revision, ownerConfigured }

  for (const report of reports) {
    const dispatch = attempts.findLast(
      (candidate) =>
        candidate.action.kind === 'dispatch-node' &&
        candidate.action.revisionId === revision.id &&
        candidate.action.taskKey === report.taskKey &&
        candidate.attempt.dispatchId === report.dispatchId
    )
    if (
      report.actionKind !== 'dispatch-node' ||
      report.taskKey === null ||
      dispatch?.action.kind !== 'dispatch-node' ||
      dispatch.attempt.dispatchId !== report.dispatchId
    ) {
      continue
    }
    const node = byKey.get(report.taskKey)
    if (!node) {
      continue
    }
    unavailableTaskKeys.add(node.taskKey)
    const projectedRejection = projectedObjectiveReportRejection(report)
    if (projectedRejection) {
      failureOutcomes.push(
        decideObjectiveReportRejection({
          ...failureContext,
          node,
          dispatchId: report.dispatchId,
          rejection: projectedRejection
        })
      )
      failedTaskKeys.add(node.taskKey)
      continue
    }
    if (report.evidenceIssue === 'files-modified-malformed') {
      failureOutcomes.push(
        decideObjectiveReportRejection({
          ...failureContext,
          node,
          dispatchId: report.dispatchId,
          rejection: {
            rejectionReason: 'implementer-report-evidence-malformed',
            reportedFiles: [],
            observedFiles: [],
            detail: 'Worker completion filesModified must be an array of workspace-relative paths',
            status: 'rejected'
          }
        })
      )
      failedTaskKeys.add(node.taskKey)
      continue
    }
    if (report.outcome !== 'succeeded' || report.reportPath === null) {
      continue
    }
    const ingestionAction = {
      kind: 'ingest-report' as const,
      capability: 'implement' as const,
      visibility: 'local' as const,
      recovery: 'replay-safe' as const,
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: report.dispatchId,
      revisionId: revision.id,
      dispatchId: report.dispatchId,
      taskKey: node.taskKey,
      orchestrationTaskId: report.orchestrationTaskId,
      reportPath: report.reportPath,
      filesModified: report.filesModified,
      dispatchedContentIdentity: report.dispatchedContentIdentity
    }
    const ingestion = latestObjectiveAttempt(
      attempts,
      (action) => action.kind === 'ingest-report' && action.dispatchId === report.dispatchId
    )
    if (!ingestion) {
      return { action: ingestionAction }
    }
    const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
    if (ingestionDisposition === 'not-landed') {
      const durableReport = projectedDispatches.find(
        (candidate) =>
          candidate.revisionId === revision.id &&
          candidate.dispatchId === report.dispatchId &&
          candidate.report !== null &&
          candidate.reportDigest !== null
      )
      const ingestionFailureClass = objectiveAttemptFailureClass(ingestion.attempt, ledger)
      if (
        (durableReport?.state === 'running' || durableReport?.state === 'resolving-conflict') &&
        ingestionFailureClass !== 'criteria'
      ) {
        return { action: ingestionAction }
      }
      if (durableReport?.state === 'resolving-conflict') {
        continue
      }
      if (
        durableReport?.state === 'waiting-to-apply' ||
        durableReport?.state === 'applying' ||
        durableReport?.state === 'applied'
      ) {
        activeTaskKeys.add(node.taskKey)
        continue
      }
      failureOutcomes.push(
        decideObjectiveReportRejection({
          ...failureContext,
          node,
          dispatchId: report.dispatchId,
          rejection: rejectedObjectiveReportResult(ingestion.attempt, ledger)
        })
      )
      failedTaskKeys.add(node.taskKey)
    } else if (ingestionDisposition === 'in-flight' || ingestionDisposition === 'indeterminate') {
      return objectiveNoAction('implementation', 'node-in-flight', node.taskKey)
    } else {
      activeTaskKeys.add(node.taskKey)
    }
  }

  const train = (snapshot.world.parallel?.dispatches ?? [])
    .filter(
      (dispatch) =>
        dispatch.revisionId === revision.id &&
        (dispatch.state === 'waiting-to-apply' ||
          dispatch.state === 'applying' ||
          dispatch.state === 'resolving-conflict')
    )
    .sort(
      (left, right) =>
        (left.completedAtMs ?? Number.MAX_SAFE_INTEGER) -
          (right.completedAtMs ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAtMs - right.createdAtMs ||
        (planOrder.get(left.taskKey) ?? 0) - (planOrder.get(right.taskKey) ?? 0)
    )
  const trainHead = train[0]
  if (trainHead?.state === 'waiting-to-apply' && trainHead.dispatchId !== null) {
    const applyAction = {
      kind: 'apply-node' as const,
      capability: 'implement' as const,
      visibility: 'local' as const,
      recovery: 'replay-safe' as const,
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: `apply:${trainHead.attemptFingerprint}`,
      revisionId: trainHead.revisionId,
      taskKey: trainHead.taskKey,
      dispatchId: trainHead.dispatchId
    }
    const application = latestObjectiveAttempt(
      attempts,
      (action) =>
        action.kind === 'apply-node' &&
        action.evidenceKey === applyAction.evidenceKey &&
        action.revisionId === trainHead.revisionId &&
        action.taskKey === trainHead.taskKey &&
        action.dispatchId === trainHead.dispatchId
    )
    if (!application) {
      return { action: applyAction }
    }
    const disposition = objectiveAttemptDisposition(application.attempt, ledger)
    if (disposition === 'not-landed') {
      return { action: applyAction }
    }
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      return objectiveNoAction('implementation', 'node-in-flight', trainHead.taskKey)
    }
  }

  let conflictRetry: ObjectiveDecisionOutcome | null = null
  if (trainHead?.state === 'resolving-conflict') {
    const original = attempts.find(
      (candidate) =>
        candidate.attempt.fingerprint === trainHead.attemptFingerprint &&
        candidate.action.kind === 'dispatch-node'
    )
    const node = byKey.get(trainHead.taskKey)
    if (original?.action.kind === 'dispatch-node' && node) {
      const latest = latestObjectiveAttempt(
        attempts,
        (action) =>
          action.kind === 'dispatch-node' &&
          action.revisionId === revision.id &&
          action.taskKey === node.taskKey
      )
      const conflictAlreadyRedispatched =
        latest !== null && latest.attempt.fingerprint !== trainHead.attemptFingerprint
      const retryOrdinal = objectiveNodeRetryCount(attempts, revision.id, node.taskKey)
      if (retryOrdinal >= OBJECTIVE_INFRA_REDISPATCH_CAP) {
        const conflictingDispatchIds = [
          trainHead.dispatchId,
          ...trainHead.conflictingDispatchIds
        ].filter((dispatchId): dispatchId is string => dispatchId !== null)
        failureOutcomes.push(
          ownerConfigured
            ? {
                action: null,
                deviation: objectiveRetryExhaustedDeviation({
                  taskKey: node.taskKey,
                  retryCount: retryOrdinal,
                  lastFailureClass: null,
                  conflictPaths: trainHead.conflictPaths,
                  conflictingDispatchIds: [...new Set(conflictingDispatchIds)]
                })
              }
            : objectiveNoAction('implementation', 'node-retry-exhausted', node.taskKey)
        )
        failedTaskKeys.add(node.taskKey)
      } else if (!inFlightTaskKeys.has(node.taskKey) && !conflictAlreadyRedispatched) {
        conflictRetry = {
          action: {
            kind: 'dispatch-node',
            capability: 'implement',
            visibility: 'local',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: `${revision.id}:${node.taskKey}:r${retryOrdinal}`,
            revisionId: revision.id,
            taskKey: node.taskKey,
            depsOrchestrationIds: original.action.depsOrchestrationIds,
            retryOf: original.action.retryOf ?? original.action.evidenceKey
          }
        }
      }
    }
  }

  for (const node of nodes) {
    if (node.state === 'succeeded' || node.state === 'replanned') {
      continue
    }
    const dispatch = latestObjectiveAttempt(
      attempts,
      (action) =>
        action.kind === 'dispatch-node' &&
        action.revisionId === revision.id &&
        action.taskKey === node.taskKey
    )
    const durableDispatch = projectedDispatches.findLast(
      (candidate) =>
        candidate.revisionId === revision.id &&
        candidate.taskKey === node.taskKey &&
        (dispatch === null ||
          candidate.attemptFingerprint === dispatch.attempt.fingerprint ||
          (dispatch.attempt.dispatchId !== undefined &&
            candidate.dispatchId === dispatch.attempt.dispatchId))
    )
    if (node.state === 'failed') {
      failureOutcomes.push(decideObjectiveNodeFailure({ ...failureContext, node, dispatch }))
      unavailableTaskKeys.add(node.taskKey)
      failedTaskKeys.add(node.taskKey)
      continue
    }
    if (!dispatch || dispatch.action.kind !== 'dispatch-node') {
      if (durableDispatch?.state === 'failed') {
        failureOutcomes.push(
          decideObjectiveNodeFailure({ ...failureContext, node, dispatch: null })
        )
        unavailableTaskKeys.add(node.taskKey)
        failedTaskKeys.add(node.taskKey)
      }
      continue
    }
    if (failedTaskKeys.has(node.taskKey)) {
      continue
    }
    const disposition = objectiveAttemptDisposition(dispatch.attempt, ledger)
    if (durableDispatch?.state === 'failed' && disposition !== 'not-landed') {
      failureOutcomes.push(decideObjectiveNodeFailure({ ...failureContext, node, dispatch }))
      unavailableTaskKeys.add(node.taskKey)
      failedTaskKeys.add(node.taskKey)
      continue
    }
    if (disposition === 'in-flight' || disposition === 'indeterminate') {
      unavailableTaskKeys.add(node.taskKey)
      activeTaskKeys.add(node.taskKey)
      continue
    }
    const dispatchId = node.dispatchId ?? dispatch.attempt.dispatchId
    const report = reports.find((candidate) => candidate.dispatchId === dispatchId)
    if (disposition === 'landed') {
      unavailableTaskKeys.add(node.taskKey)
      if (!report) {
        failureOutcomes.push(
          decideObjectiveNodeFailure({
            ...failureContext,
            node,
            dispatch,
            summary: 'the dispatch settled as landed but the worker never produced a report'
          })
        )
        failedTaskKeys.add(node.taskKey)
      }
      continue
    }
    const pausedDispatch = objectivePausedDispatchRetry(dispatch, snapshot.contentIdentity)
    if (pausedDispatch) {
      if (trainHead?.state === 'resolving-conflict' && trainHead.taskKey === node.taskKey) {
        conflictRetry = { action: pausedDispatch }
      } else {
        retryByTaskKey.set(node.taskKey, { action: pausedDispatch })
      }
      continue
    }
    const retryable = objectiveRetryableFailure(dispatch.attempt, ledger)
    if (retryable === null) {
      unavailableTaskKeys.add(node.taskKey)
      failureOutcomes.push(decideObjectiveNodeFailure({ ...failureContext, node, dispatch }))
      failedTaskKeys.add(node.taskKey)
      continue
    }
    const retryOrdinal = objectiveNodeRetryCount(attempts, revision.id, node.taskKey)
    if (retryOrdinal >= OBJECTIVE_INFRA_REDISPATCH_CAP) {
      unavailableTaskKeys.add(node.taskKey)
      failureOutcomes.push(
        ownerConfigured
          ? {
              action: null,
              deviation: objectiveRetryExhaustedDeviation({
                taskKey: node.taskKey,
                retryCount: retryOrdinal,
                lastFailureClass: retryable
              })
            }
          : objectiveNoAction('implementation', 'node-retry-exhausted', node.taskKey)
      )
      failedTaskKeys.add(node.taskKey)
      continue
    }
    retryByTaskKey.set(node.taskKey, {
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `${revision.id}:${node.taskKey}:r${retryOrdinal}`,
        revisionId: revision.id,
        taskKey: node.taskKey,
        depsOrchestrationIds: dispatch.action.depsOrchestrationIds,
        retryOf: dispatch.action.retryOf ?? dispatch.action.evidenceKey
      }
    })
  }

  if (conflictRetry) {
    return conflictRetry
  }

  const exclusiveRoleInFlight = objectiveExclusiveRoleInFlight(attempts, ledger)
  const slotState = objectiveParallelSlotState(snapshot.world, ledger, revision.id)
  const budgetExhausted = deriveBudgetState(ledger, snapshot.world.budget).exhausted !== null
  if (!budgetExhausted && !exclusiveRoleInFlight && slotState.availableSlots > 0) {
    const retryableTaskKeys = new Set(retryByTaskKey.keys())
    const schedulingUnavailable = new Set(
      [...unavailableTaskKeys].filter((taskKey) => !retryableTaskKeys.has(taskKey))
    )
    const readyTaskKeys = prioritizeReadyObjectiveTaskKeys(
      nodes,
      schedulingUnavailable,
      retryableTaskKeys,
      slotState.effectiveMaxConcurrency > 1
    )
    let missingDependencyTaskId: string | null = null
    for (const taskKey of readyTaskKeys) {
      const retry = retryByTaskKey.get(taskKey)
      if (retry) {
        return retry
      }
      const node = byKey.get(taskKey)
      if (!node) {
        continue
      }
      const depsOrchestrationIds: string[] = []
      let dependencyProjectionReady = true
      for (const dependencyKey of node.deps) {
        const dependency = byKey.get(dependencyKey)
        if (!dependency?.orchestrationTaskId) {
          dependencyProjectionReady = false
          missingDependencyTaskId ??= node.taskKey
          break
        }
        depsOrchestrationIds.push(dependency.orchestrationTaskId)
      }
      if (!dependencyProjectionReady) {
        continue
      }
      return {
        action: {
          kind: 'dispatch-node',
          capability: 'implement',
          visibility: 'local',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: `${revision.id}:${node.taskKey}`,
          revisionId: revision.id,
          taskKey: node.taskKey,
          depsOrchestrationIds
        }
      }
    }
    if (missingDependencyTaskId !== null) {
      return objectiveNoAction(
        'implementation',
        'dependency-task-id-unavailable',
        missingDependencyTaskId
      )
    }
  }

  const incomplete = nodes.filter(
    (node) => node.state !== 'succeeded' && node.state !== 'replanned'
  )
  const activeTaskKey =
    incomplete.find((node) => activeTaskKeys.has(node.taskKey) && !failedTaskKeys.has(node.taskKey))
      ?.taskKey ?? null
  if (activeTaskKey !== null) {
    return objectiveNoAction('implementation', 'node-in-flight', activeTaskKey)
  }
  if (failureOutcomes.length > 0) {
    return failureOutcomes[0]
  }
  if (incomplete.length > 0) {
    const lengths = objectiveRemainingChainLengths(nodes)
    const blocked = [...incomplete].sort(
      (left, right) =>
        (lengths.get(right.taskKey) ?? 0) - (lengths.get(left.taskKey) ?? 0) ||
        (planOrder.get(left.taskKey) ?? 0) - (planOrder.get(right.taskKey) ?? 0)
    )[0]
    return objectiveNoAction('implementation', 'nodes-blocked-by-dependencies', blocked?.taskKey)
  }
  return null
}
