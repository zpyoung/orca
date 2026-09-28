import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import { objectiveFrozenTaskKeys } from '../../shared/fork-heimdall-objective/objective-repair-state'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { buildRepairPlanContext, type RepairPlanContext } from './repair-plan-context'
import type { ObjectiveStore } from './objective-store'

/** taskKey -> the latest applied-or-reporting dispatch record's report, for a repair prompt's frozen-task summaries. */
function repairDispatchReportsByTaskKey(
  records: readonly ObjectiveDispatchRecord[],
  revisionId: string
): ReadonlyMap<
  string,
  { summary: string; filesModified: readonly string[]; completedAtMs?: number }
> {
  const latestByTaskKey = new Map<string, ObjectiveDispatchRecord>()
  for (const record of records) {
    if (record.revisionId !== revisionId || record.report === null) {
      continue
    }
    const existing = latestByTaskKey.get(record.taskKey)
    if (!existing) {
      latestByTaskKey.set(record.taskKey, record)
      continue
    }
    const existingIsApplied = existing.state === 'applied'
    const candidateIsApplied = record.state === 'applied'
    const existingAtMs = existing.completedAtMs ?? existing.createdAtMs
    const candidateAtMs = record.completedAtMs ?? record.createdAtMs
    if (
      (candidateIsApplied && !existingIsApplied) ||
      (candidateIsApplied === existingIsApplied && candidateAtMs > existingAtMs)
    ) {
      latestByTaskKey.set(record.taskKey, record)
    }
  }
  const reports = new Map<
    string,
    { summary: string; filesModified: readonly string[]; completedAtMs?: number }
  >()
  for (const [taskKey, record] of latestByTaskKey) {
    if (!record.report) {
      continue
    }
    reports.set(taskKey, {
      summary: record.report.summary,
      filesModified: record.report.filesModified,
      ...(record.completedAtMs === null ? {} : { completedAtMs: record.completedAtMs })
    })
  }
  return reports
}

/** Gathers a repair planner prompt's open/frozen task context from the store's live plan and dispatch history. */
export function deriveObjectiveRepairContext(
  objectiveStore: ObjectiveStore,
  watcherId: string,
  ledger: ExecuteContext<ObjectiveWorld>['ledger'],
  worldForFrozenKeys: ObjectiveWorld,
  repairRevisionId: string
): RepairPlanContext | undefined {
  const plan = objectiveStore.getPlan(repairRevisionId)
  if (!plan) {
    return undefined
  }
  const nodeStates = new Map(
    objectiveStore
      .project(watcherId, ledger)
      .nodes.filter((node) => node.revisionId === repairRevisionId)
      .map((node) => [node.taskKey, node.state] as const)
  )
  return buildRepairPlanContext({
    plan,
    nodeStates,
    frozenTaskKeys: objectiveFrozenTaskKeys(worldForFrozenKeys, ledger, repairRevisionId),
    reports: repairDispatchReportsByTaskKey(
      objectiveStore.listDispatches(watcherId),
      repairRevisionId
    )
  })
}
