import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import {
  decidePlannerAction,
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
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

export function decideObjectiveNodes(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  attempts: readonly ObjectiveAttempt[],
  reports: readonly ObjectivePendingReport[],
  revision: ObjectiveRevisionProjection
): ObjectiveDecisionOutcome | null {
  const nodes = snapshot.world.plan.nodes.filter((node) => node.revisionId === revision.id)
  if (nodes.some((node) => node.state === 'failed')) {
    return decidePlannerAction(
      snapshot,
      ledger,
      attempts,
      reports,
      'replan-after-failure',
      revision.number
    )
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
    const dispatchId = node.dispatchId ?? dispatch?.attempt.dispatchId
    const report = reports.find((candidate) => candidate.dispatchId === dispatchId)
    if (report?.outcome === 'succeeded' && report.reportPath !== null && dispatchId) {
      const ingestion = latestObjectiveAttempt(
        attempts,
        (action) => action.kind === 'ingest-report' && action.dispatchId === dispatchId
      )
      if (!ingestion) {
        return {
          action: {
            kind: 'ingest-report',
            capability: 'implement',
            visibility: 'local',
            recovery: 'replay-safe',
            contentIdentity: snapshot.contentIdentity,
            evidenceKey: dispatchId,
            revisionId: revision.id,
            dispatchId,
            taskKey: node.taskKey,
            orchestrationTaskId: report.orchestrationTaskId,
            reportPath: report.reportPath,
            filesModified: report.filesModified,
            dispatchedContentIdentity: report.dispatchedContentIdentity
          }
        }
      }
      const ingestionDisposition = objectiveAttemptDisposition(ingestion.attempt, ledger)
      if (ingestionDisposition === 'not-landed') {
        return decidePlannerAction(
          snapshot,
          ledger,
          attempts,
          reports,
          'replan-after-failure',
          revision.number
        )
      }
      return objectiveNoAction('implementation', 'projection-refresh-pending', dispatchId)
    }
    if (dispatch) {
      const disposition = objectiveAttemptDisposition(dispatch.attempt, ledger)
      if (disposition === 'not-landed') {
        const retryable = objectiveRetryableFailure(dispatch.attempt, ledger)
        if (retryable !== null) {
          const retryOrdinal = objectiveNodeRetryCount(attempts, revision.id, node.taskKey)
          if (retryOrdinal >= OBJECTIVE_INFRA_REDISPATCH_CAP) {
            return objectiveNoAction('implementation', 'node-retry-exhausted', node.taskKey)
          }
          return {
            action: {
              kind: 'dispatch-node',
              capability: 'implement',
              visibility: 'local',
              contentIdentity: snapshot.contentIdentity,
              evidenceKey: `${revision.id}:${node.taskKey}:r${retryOrdinal}`,
              revisionId: revision.id,
              taskKey: node.taskKey,
              depsOrchestrationIds:
                dispatch.action.kind === 'dispatch-node'
                  ? dispatch.action.depsOrchestrationIds
                  : [],
              retryOf: `${revision.id}:${node.taskKey}`
            }
          }
        }
        return decidePlannerAction(
          snapshot,
          ledger,
          attempts,
          reports,
          'replan-after-failure',
          revision.number
        )
      }
      if (disposition === 'landed') {
        return decidePlannerAction(
          snapshot,
          ledger,
          attempts,
          reports,
          'replan-after-failure',
          revision.number
        )
      }
      return objectiveNoAction('implementation', 'node-in-flight', node.taskKey)
    }
  }

  const byKey = new Map(nodes.map((node) => [node.taskKey, node]))
  for (const node of nodes) {
    if (node.state !== 'pending' && node.state !== 'awaiting-approval') {
      continue
    }
    const dependencies = node.deps.map((dependency) => byKey.get(dependency))
    if (dependencies.some((dependency) => dependency?.state !== 'succeeded')) {
      continue
    }
    const depsOrchestrationIds: string[] = []
    for (const dependency of dependencies) {
      if (!dependency?.orchestrationTaskId) {
        return objectiveNoAction('implementation', 'dependency-task-id-unavailable', node.taskKey)
      }
      depsOrchestrationIds.push(dependency.orchestrationTaskId)
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

  if (nodes.some((node) => node.state !== 'succeeded' && node.state !== 'replanned')) {
    return objectiveNoAction('implementation', 'nodes-blocked-by-dependencies')
  }
  return null
}
