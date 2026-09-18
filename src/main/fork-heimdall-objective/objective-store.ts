import type {
  ObjectiveEnrollmentPayload,
  ObjectiveLandingBar
} from '../../shared/fork-heimdall-objective/contract-types'
import type {
  ObjectiveDetail,
  ObjectiveProjection
} from '../../shared/fork-heimdall-objective/detail-types'
import type {
  ObjectivePlan,
  ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDatabase } from './objective-database'
import type {
  ActivatePlanArgs,
  ActivatePlanResult,
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
  RecordVerdictArgs,
  StartCheckAttemptArgs
} from './objective-store-data'
import { ObjectiveStoreMutations } from './objective-store-mutations'
import { detailObjective, projectObjective } from './objective-store-projection'
import { ObjectiveStoreQueries } from './objective-store-queries'
import { reconcileObjectiveLedger } from './objective-store-reconciliation'

export type {
  ActivatePlanArgs,
  ActivatePlanResult,
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
  RecordVerdictArgs,
  StartCheckAttemptArgs
} from './objective-store-data'

/** Natural-keyed objective state, with large report bodies kept out of the kernel ledger. */
export class ObjectiveStore {
  private readonly mutations: ObjectiveStoreMutations
  private readonly queries: ObjectiveStoreQueries

  constructor(
    private readonly database: ObjectiveDatabase,
    private readonly now: () => number = Date.now
  ) {
    this.mutations = new ObjectiveStoreMutations(database)
    this.queries = new ObjectiveStoreQueries(database)
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

  nodeForDispatch(
    watcherId: string,
    dispatchId: string
  ): { revisionId: string; taskKey: string } | null {
    return this.queries.nodeForDispatch(watcherId, dispatchId)
  }

  getPlan(revisionId: string): ObjectivePlan | null {
    return this.queries.getPlan(revisionId)
  }

  getTask(revisionId: string, taskKey: string): ObjectivePlanTask | null {
    return this.queries.getTask(revisionId, taskKey)
  }

  getCriterion(criterionId: string): ObjectiveStoredCriterion | null {
    return this.queries.getCriterion(criterionId)
  }

  startCheckAttempt(args: StartCheckAttemptArgs): ObjectiveCheckAttempt {
    return this.mutations.startCheckAttempt(args)
  }

  completeCheckAttempt(args: CompleteCheckAttemptArgs): ObjectiveCheckAttempt {
    return this.mutations.completeCheckAttempt(args)
  }

  getCheckAttempt(criterionId: string, contentIdentity: string): ObjectiveCheckAttempt | null {
    return this.queries.getCheckAttempt(criterionId, contentIdentity)
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
    return detailObjective(this.database, this.now, watcherId, contract, ledger)
  }

  purge(watcherId: string): void {
    this.mutations.purge(watcherId)
  }

  reconcile(ledger: WatcherLedger): ObjectiveReconcileResult {
    return reconcileObjectiveLedger(this.database, this.queries, this.mutations, ledger)
  }
}
