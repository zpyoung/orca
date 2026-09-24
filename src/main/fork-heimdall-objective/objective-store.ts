import type {
  ObjectiveEnrollmentPayload,
  ObjectiveLandingBar
} from '../../shared/fork-heimdall-objective/contract-types'
import type {
  ObjectiveDetail,
  ObjectiveProjection
} from '../../shared/fork-heimdall-objective/detail-types'
import {
  ObjectiveParallelProjectionSchema,
  type ObjectiveDispatchRecord,
  type ObjectiveParallelProjection
} from '../../shared/fork-heimdall-objective/parallel-types'
import type { PlanReviewReport } from '../../shared/fork-heimdall-objective/plan-review-schema'
import type {
  ObjectivePlan,
  ObjectivePlanTask,
  PlannerReport
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDatabase } from './objective-database'
import type {
  ActivatePlanArgs,
  ActivatePlanResult,
  AmendRevisionArgs,
  CompleteCheckAttemptArgs,
  IngestPlanArgs,
  IngestPlanResult,
  ObjectiveCheckAttempt,
  ObjectiveLandingPayload,
  ObjectiveReconcileResult,
  ObjectiveStoredCriterion,
  RecordLandingArgs,
  RecordLandingResult,
  RecordNodeDispatchArgs,
  RecordOwnerCheckSkipArgs,
  RecordVerdictArgs,
  RevisionAmendmentResult,
  StartCheckAttemptArgs
} from './objective-store-data'
import { ObjectiveStoreDispatchMutations } from './objective-store-dispatch-mutations'
import {
  completeGateAttempt,
  getGateAttempt,
  listGateAttempts,
  startGateAttempt,
  type CompleteGateAttemptArgs,
  type ObjectiveGateAttempt,
  type StartGateAttemptArgs
} from './objective-store-gate-attempts'
import {
  ObjectiveStoreMutations,
  type AbandonCheckAttemptArgs,
  type AbandonGateAttemptArgs
} from './objective-store-mutations'
import {
  applyPlanPatch,
  getPlanPatch,
  ingestPlanPatch,
  listPlanPatches,
  rejectDraftRevision,
  rejectPlanPatch,
  type ApplyPlanPatchArgs,
  type ApplyPlanPatchResult,
  type IngestPlanPatchArgs,
  type ObjectivePlanPatchRecord,
  type RejectPlanPatchArgs
} from './objective-store-plan-patches'
import {
  getPlanReviewReport,
  listPlanReviews,
  recordPlanReview,
  recordPlanReviewAndRejectRoundOneTarget,
  type ObjectivePlanReviewRecord,
  type RecordPlanReviewArgs
} from './objective-store-plan-reviews'
import { detailObjective, projectObjective } from './objective-store-projection'
import { ObjectiveStoreQueries } from './objective-store-queries'
import { reconcileObjectiveLedger } from './objective-store-reconciliation'

export type {
  ActivatePlanArgs,
  ActivatePlanResult,
  AmendRevisionArgs,
  CompleteCheckAttemptArgs,
  IngestPlanArgs,
  IngestPlanResult,
  ObjectiveCheckAttempt,
  ObjectiveLandingPayload,
  ObjectiveReconcileResult,
  ObjectiveStoredCriterion,
  RecordLandingArgs,
  RecordLandingResult,
  RecordNodeDispatchArgs,
  RecordOwnerCheckSkipArgs,
  RecordVerdictArgs,
  RevisionAmendmentResult,
  StartCheckAttemptArgs
} from './objective-store-data'
export type {
  CompleteGateAttemptArgs,
  ObjectiveGateAttempt,
  StartGateAttemptArgs
} from './objective-store-gate-attempts'
export type { AbandonCheckAttemptArgs, AbandonGateAttemptArgs } from './objective-store-mutations'
export type {
  ApplyPlanPatchArgs,
  ApplyPlanPatchResult,
  IngestPlanPatchArgs,
  ObjectivePlanPatchRecord,
  RejectPlanPatchArgs
} from './objective-store-plan-patches'
export type {
  ObjectivePlanReviewRecord,
  RecordPlanReviewArgs
} from './objective-store-plan-reviews'

/** Natural-keyed objective state, with large report bodies kept out of the kernel ledger. */
export class ObjectiveStore {
  private readonly mutations: ObjectiveStoreMutations
  private readonly dispatchMutations: ObjectiveStoreDispatchMutations
  private readonly queries: ObjectiveStoreQueries

  constructor(
    private readonly database: ObjectiveDatabase,
    private readonly now: () => number = Date.now
  ) {
    this.dispatchMutations = new ObjectiveStoreDispatchMutations(database)
    this.mutations = new ObjectiveStoreMutations(database)
    this.queries = new ObjectiveStoreQueries(database)
  }

  getDispatch(attemptFingerprint: string): ObjectiveDispatchRecord | null {
    return this.queries.getDispatch(attemptFingerprint)
  }

  listDispatches(watcherId: string): ObjectiveDispatchRecord[] {
    return this.queries.listDispatches(watcherId)
  }

  dispatchForId(watcherId: string, dispatchId: string): ObjectiveDispatchRecord | null {
    return this.queries.dispatchForId(watcherId, dispatchId)
  }

  saveDispatch(record: ObjectiveDispatchRecord): ObjectiveDispatchRecord {
    return this.dispatchMutations.save(record)
  }

  setParallelNote(watcherId: string, note: string | null): void {
    this.dispatchMutations.setNote(watcherId, note, this.now())
  }

  clearParallelNoteWithPrefix(watcherId: string, prefix: string): void {
    this.dispatchMutations.clearNoteWithPrefix(watcherId, prefix)
  }

  parallelProjection(
    watcherId: string,
    contract: ObjectiveEnrollmentPayload
  ): ObjectiveParallelProjection {
    const dispatches = this.queries.listDispatches(watcherId)
    const effectiveMaxConcurrency =
      contract.workspaceKind === 'folder' ? 1 : contract.maxConcurrency
    const note =
      contract.workspaceKind === 'folder' && contract.maxConcurrency > 1
        ? 'Folder workspaces cannot create dispatch worktrees; concurrency is limited to 1.'
        : this.queries.parallelNote(watcherId)
    return ObjectiveParallelProjectionSchema.parse({
      effectiveMaxConcurrency,
      runningCount: dispatches.filter(
        (dispatch) =>
          dispatch.state === 'running' ||
          dispatch.state === 'waiting-to-apply' ||
          dispatch.state === 'applying' ||
          dispatch.state === 'resolving-conflict'
      ).length,
      ...(note ? { note } : {}),
      dispatches
    })
  }

  databasePath(): string {
    return this.database.databasePath()
  }

  ingestPlan(args: IngestPlanArgs): IngestPlanResult {
    return this.mutations.ingestPlan(args)
  }

  activatePlan(args: ActivatePlanArgs): ActivatePlanResult {
    return this.mutations.activatePlan(args)
  }

  recordNodeDispatch(args: RecordNodeDispatchArgs): RecordNodeDispatchArgs {
    return this.mutations.recordNodeDispatch(args)
  }

  amendRevision(args: AmendRevisionArgs): RevisionAmendmentResult {
    return this.mutations.amendRevision(args)
  }

  hasAmendment(revisionId: string, digest: string): boolean {
    return this.queries.hasAmendment(revisionId, digest)
  }

  nodeForDispatch(
    watcherId: string,
    dispatchId: string
  ): { revisionId: string; taskKey: string } | null {
    return this.queries.nodeForDispatch(watcherId, dispatchId)
  }

  getPlan(revisionId: string): ObjectivePlan | null {
    return this.queries.getPlan(revisionId)
  }

  getPlanReport(revisionId: string): PlannerReport | null {
    return this.queries.getPlanReport(revisionId)
  }

  getTask(revisionId: string, taskKey: string): ObjectivePlanTask | null {
    return this.queries.getTask(revisionId, taskKey)
  }

  rejectDraftRevision(args: { watcherId: string; revisionId: string }): void {
    return rejectDraftRevision(this.database, args)
  }

  ingestPlanPatch(args: IngestPlanPatchArgs): ObjectivePlanPatchRecord {
    return ingestPlanPatch(this.database, args)
  }

  rejectPlanPatch(args: RejectPlanPatchArgs): ObjectivePlanPatchRecord {
    return rejectPlanPatch(this.database, args)
  }

  applyPlanPatch(args: ApplyPlanPatchArgs): ApplyPlanPatchResult {
    return applyPlanPatch(this.database, args)
  }

  getPlanPatch(patchId: string): ObjectivePlanPatchRecord | null {
    return getPlanPatch(this.database, patchId)
  }

  listPlanPatches(watcherId: string): ObjectivePlanPatchRecord[] {
    return listPlanPatches(this.database, watcherId)
  }

  recordPlanReview(args: RecordPlanReviewArgs): ObjectivePlanReviewRecord {
    return recordPlanReview(this.database, args)
  }

  /** Records a plan review and, when it is a round-one `revise`, rejects its target atomically. */
  recordPlanReviewAndRejectRoundOneTarget(args: RecordPlanReviewArgs): ObjectivePlanReviewRecord {
    return recordPlanReviewAndRejectRoundOneTarget(this.database, args)
  }

  listPlanReviews(watcherId: string): ObjectivePlanReviewRecord[] {
    return listPlanReviews(this.database, watcherId)
  }

  getPlanReviewReport(id: string): PlanReviewReport | null {
    return getPlanReviewReport(this.database, id)
  }

  startGateAttempt(args: StartGateAttemptArgs): ObjectiveGateAttempt {
    return startGateAttempt(this.database, args)
  }

  completeGateAttempt(args: CompleteGateAttemptArgs): ObjectiveGateAttempt {
    return completeGateAttempt(this.database, args)
  }

  getGateAttempt(
    watcherId: string,
    gateName: string,
    contentIdentity: string
  ): ObjectiveGateAttempt | null {
    return getGateAttempt(this.database, watcherId, gateName, contentIdentity)
  }

  listGateAttempts(watcherId: string): ObjectiveGateAttempt[] {
    return listGateAttempts(this.database, watcherId)
  }

  abandonGateAttempt(args: AbandonGateAttemptArgs): void {
    this.mutations.abandonGateAttempt(args)
  }

  getCriterion(criterionId: string): ObjectiveStoredCriterion | null {
    return this.queries.getCriterion(criterionId)
  }

  startCheckAttempt(args: StartCheckAttemptArgs): ObjectiveCheckAttempt {
    return this.mutations.startCheckAttempt(args)
  }

  recordOwnerCheckSkip(args: RecordOwnerCheckSkipArgs): ObjectiveCheckAttempt {
    return this.mutations.recordOwnerCheckSkip(args)
  }

  completeCheckAttempt(args: CompleteCheckAttemptArgs): ObjectiveCheckAttempt {
    return this.mutations.completeCheckAttempt(args)
  }

  getCheckAttempt(criterionId: string, contentIdentity: string): ObjectiveCheckAttempt | null {
    return this.queries.getCheckAttempt(criterionId, contentIdentity)
  }

  abandonCheckAttempt(args: AbandonCheckAttemptArgs): void {
    this.mutations.abandonCheckAttempt(args)
  }

  hasCheckAttempt(criterionId: string, contentIdentity: string, completed = false): boolean {
    return this.queries.hasCheckAttempt(criterionId, contentIdentity, completed)
  }

  recordVerdict(args: RecordVerdictArgs): { dispatchId: string; reportDigest: string } {
    return this.mutations.recordVerdict(args)
  }

  recordLanding(args: RecordLandingArgs): RecordLandingResult {
    return this.mutations.recordLanding(args)
  }

  hasPlanRevision(watcherId: string, revisionId: string, digest?: string): boolean {
    return this.queries.hasPlanRevision(watcherId, revisionId, digest)
  }
  hasUsablePlan(watcherId: string): boolean {
    return this.queries.hasUsablePlan(watcherId)
  }

  planForDispatch(
    watcherId: string,
    dispatchId: string
  ): { revisionId: string; revisionNumber: number; digest: string } | null {
    return this.queries.planForDispatch(watcherId, dispatchId)
  }

  isPlanActivated(watcherId: string, revisionId: string, digest: string): boolean {
    return this.queries.isPlanActivated(watcherId, revisionId, digest)
  }

  hasVerdict(dispatchId: string, reportDigest?: string): boolean {
    return this.queries.hasVerdict(dispatchId, reportDigest)
  }

  hasLanding(watcherId: string, rung: ObjectiveLandingBar, contentIdentity: string): boolean {
    return this.queries.hasLanding(watcherId, rung, contentIdentity)
  }

  landingRow(
    watcherId: string,
    rung: ObjectiveLandingBar,
    contentIdentity: string
  ): ObjectiveLandingPayload | null {
    return this.queries.landingRow(watcherId, rung, contentIdentity)
  }

  project(
    watcherId: string,
    ledger?: WatcherLedger,
    contentIdentity?: string
  ): ObjectiveProjection {
    return projectObjective(this.database, watcherId, ledger, contentIdentity)
  }

  detail(
    watcherId: string,
    contract: ObjectiveEnrollmentPayload,
    ledger?: WatcherLedger
  ): ObjectiveDetail {
    return {
      ...detailObjective(this.database, this.now, watcherId, contract, ledger),
      parallel: this.parallelProjection(watcherId, contract)
    }
  }

  purge(watcherId: string): void {
    this.mutations.purge(watcherId)
  }

  reconcile(ledger: WatcherLedger): ObjectiveReconcileResult {
    return reconcileObjectiveLedger(this.database, this.queries, this.mutations, ledger)
  }
}
