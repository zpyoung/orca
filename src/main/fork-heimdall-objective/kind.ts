import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type { HandoffAdapter, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PacingTier } from '../../shared/fork-heimdall/pacing'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentPayloadSchema } from '../../shared/fork-heimdall-objective/contract-types'
import {
  highestReachedRung,
  reachedRungs,
  stopRungForBar
} from '../../shared/fork-heimdall-objective/landing-ladder'
import { deriveHandoffInput } from '../../shared/fork-heimdall-objective/objective-handoff-policy'
import {
  decideObjective,
  type ObjectiveDecisionOutcome
} from '../../shared/fork-heimdall-objective/decision'
import { objectiveNoAction } from '../../shared/fork-heimdall-objective/decision-context'
import {
  ObjectiveWorldSchema,
  type ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { paceObjective } from '../../shared/fork-heimdall-objective/pacing'
import { OBJECTIVE_STOP_PREDICATES } from '../../shared/fork-heimdall-objective/stop-policy'
import type { Store } from '../persistence'
import { runtimeFileSshTargetId } from '../runtime/runtime-file-command-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createObjectiveActionExecutor } from './action-executor'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { defaultObjectiveForgeAccess, type ObjectiveForgeAccess } from './objective-forge-access'
import {
  assertObjectiveEnrollmentHasUsablePlan,
  authorizeObjectiveEnrollment,
  objectiveContractFromEnrollment
} from './definition'
import {
  bindObjectiveSnapshot,
  requireObjectiveSnapshotBinding,
  type ObjectiveSnapshotBinding
} from './execution-context'
import { readObjectiveLandingContext } from './landing-snapshot'
import { HostedReviewLandingPayloadSchema } from './objective-store-data'
import type { ObjectiveStore } from './objective-store'
import { resolveObjectiveWorkspaceTarget } from './workspace-target'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'

export type ObjectiveKind = WatcherKind<ObjectiveWorld, ObjectiveAction, ObjectiveEnrollmentPayload>
const PLAN_OFF_WITHOUT_USABLE_PLAN = 'plan-off-without-usable-plan'

export function decideObjectiveForEnrollment(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  enrollment: WatcherEnrollment
): ObjectiveDecisionOutcome {
  const decision = decideObjective(snapshot, ledger)
  const requiresPlan =
    decision.action?.capability === 'plan' ||
    (decision.action === null &&
      decision.considered.some((considered) => considered.phase === 'plan'))
  if (enrollment.capabilities.plan !== 'off' || !requiresPlan) {
    return decision
  }
  return objectiveNoAction('plan', PLAN_OFF_WITHOUT_USABLE_PLAN)
}

export function paceObjectiveForEnrollment(
  snapshot: Snapshot<ObjectiveWorld>,
  ledger: WatcherLedger,
  decision: ObjectiveDecisionOutcome
): PacingTier {
  return decision.action === null && decision.reason === PLAN_OFF_WITHOUT_USABLE_PLAN
    ? 'idle'
    : paceObjective(snapshot, ledger)
}

function checkTargetAvailable(target: ObjectiveWorkspaceTarget): boolean {
  if (target.fileProvider === null) {
    return (
      target.executionHostId === 'local' &&
      target.gitTarget?.localGitOptions?.wslDistro === undefined
    )
  }
  try {
    return runtimeFileSshTargetId(target) !== undefined
  } catch {
    return false
  }
}

function objectivePreflight(args: {
  action: ObjectiveAction
  snapshot: Snapshot<ObjectiveWorld>
  ledger: WatcherLedger
  enrollment: WatcherEnrollment
  target: ObjectiveWorkspaceTarget
}): GateVerdict {
  if (
    args.action.kind.startsWith('dispatch-') &&
    deriveBudgetState(args.ledger, args.enrollment.budget).exhausted
  ) {
    return { verdict: 'hold', reason: 'budget-bucket-exhausted' }
  }
  if (args.action.kind === 'run-check' && !checkTargetAvailable(args.target)) {
    return { verdict: 'hold', reason: 'check-target-unavailable' }
  }
  if (args.action.kind === 'record-landing') {
    const revisionId = args.action.revisionId
    const verified = args.snapshot.world.plan.nodes
      .filter((node) => node.revisionId === revisionId)
      .flatMap((node) => node.criteria)
      .filter((criterion) => criterion.shellCheckable)
      .every(
        (criterion) =>
          criterion.lastCheck?.contentIdentity === args.snapshot.contentIdentity &&
          criterion.lastCheck.exitCode === 0 &&
          !criterion.lastCheck.timedOut
      )
    if (!verified) {
      return { verdict: 'hold', reason: 'criteria-unverified' }
    }
  }
  return { verdict: 'allow' }
}

function objectivePhase(snapshot: Snapshot<ObjectiveWorld>): string {
  const reached = reachedRungs(snapshot.world.plan.landing, snapshot.contentIdentity)
  const currentLanding = highestReachedRung(snapshot.world.plan.landing, snapshot.contentIdentity)
  if (reached.has(stopRungForBar(snapshot.world.contract.landingBar))) {
    return 'landed'
  }
  if (currentLanding !== null) {
    return 'landing'
  }
  const revision = snapshot.world.plan.revisions.find((entry) => entry.status === 'approved')
  if (!revision) {
    return 'planning'
  }
  const nodes = snapshot.world.plan.nodes.filter((node) => node.revisionId === revision.id)
  if (nodes.some((node) => node.state !== 'succeeded' && node.state !== 'replanned')) {
    return 'implementation'
  }
  const checksCurrent = nodes
    .flatMap((node) => node.criteria)
    .filter((criterion) => criterion.shellCheckable)
    .every((criterion) => criterion.lastCheck?.contentIdentity === snapshot.contentIdentity)
  return checksCurrent ? 'review' : 'checks'
}

function objectiveHandoffAdapter(objectiveStore: ObjectiveStore): HandoffAdapter<ObjectiveWorld> {
  return {
    derive(enrollment, fired, ledger) {
      const contract = objectiveContractFromEnrollment(enrollment)
      if (stopRungForBar(contract.landingBar) !== 'hosted-review') {
        return { kind: 'none', reason: 'bar-below-hosted-review' }
      }
      if (!fired.detail) {
        return { kind: 'none', reason: 'hosted-review-row-missing' }
      }
      const landing = HostedReviewLandingPayloadSchema.safeParse(
        objectiveStore.landingRow(enrollment.watcherId, 'hosted-review', fired.detail)
      )
      if (!landing.success) {
        return { kind: 'none', reason: 'hosted-review-row-missing' }
      }
      return {
        kind: 'enroll',
        input: deriveHandoffInput({
          enrollment,
          contract,
          landing: landing.data,
          budgetState: deriveBudgetState(ledger, enrollment.budget)
        }),
        reason: 'bar-reached'
      }
    }
  }
}

export function createObjectiveKind(args: {
  runtime: OrcaRuntimeService
  store: Store
  objectiveStore: ObjectiveStore
  storageAuthority?: 'desktop' | 'runtime'
  forge?: ObjectiveForgeAccess
}): ObjectiveKind {
  const snapshotBindings = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>()
  const snapshotDecisions = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveDecisionOutcome>()
  const forge = args.forge ?? defaultObjectiveForgeAccess
  const executor = createObjectiveActionExecutor({
    store: args.store,
    objectiveStore: args.objectiveStore,
    snapshotBindings,
    forge
  })
  return {
    id: 'objective',
    displayName: 'Objective',
    enrollmentPayloadSchema: ObjectiveEnrollmentPayloadSchema,
    authorizeEnrollment: (input) =>
      authorizeObjectiveEnrollment(
        args.runtime,
        args.store,
        input,
        args.storageAuthority ?? 'desktop',
        forge
      ),
    validateEnrollment(candidate, existing) {
      assertObjectiveEnrollmentHasUsablePlan(
        candidate,
        existing,
        existing?.kind === 'objective' && args.objectiveStore.hasUsablePlan(existing.watcherId)
      )
    },
    describeEnrollment(enrollment) {
      const text = objectiveContractFromEnrollment(enrollment).objectiveText
      return text.length > 96 ? `${text.slice(0, 93)}...` : text
    },
    async read(enrollment, options): Promise<Snapshot<ObjectiveWorld>> {
      const contract = objectiveContractFromEnrollment(enrollment)
      const target = await resolveObjectiveWorkspaceTarget(args.runtime, enrollment)
      if (target.kind !== contract.workspaceKind) {
        throw new Error('Objective workspace kind changed after enrollment')
      }
      const contentIdentity = await computeWorkspaceContentIdentity(target)
      const projection = args.objectiveStore.project(
        enrollment.watcherId,
        undefined,
        contentIdentity
      )
      const landingContext = await readObjectiveLandingContext({
        target,
        projection,
        contentIdentity,
        repoKey: enrollment.repoId,
        landingBar: contract.landingBar,
        forge
      })
      const world = ObjectiveWorldSchema.parse({
        contract,
        workspaceKind: target.kind,
        plan: projection,
        reports: [],
        budget: enrollment.budget,
        landingContext
      })
      const snapshot: Snapshot<ObjectiveWorld> = {
        freshness: options.fresh ? 'live' : 'cached',
        contentIdentity,
        observedAtMs: Date.now(),
        world
      }
      return bindObjectiveSnapshot(snapshotBindings, snapshot, { enrollment, contract, target })
    },
    describeSnapshot(snapshot) {
      const revision = snapshot.world.plan.revisions
        .filter((entry) => entry.status === 'approved')
        .sort((left, right) => right.number - left.number)[0]
      const nodes = revision
        ? snapshot.world.plan.nodes.filter((node) => node.revisionId === revision.id)
        : []
      return {
        contentIdentity: snapshot.contentIdentity.slice(0, 12),
        revision: revision?.number ?? null,
        nodesDone: nodes.filter((node) => node.state === 'succeeded').length,
        nodesTotal: nodes.length,
        phase: objectivePhase(snapshot),
        branch: snapshot.world.landingContext.branch
      }
    },
    decide(snapshot, ledger) {
      const decision = decideObjectiveForEnrollment(
        snapshot,
        ledger,
        requireObjectiveSnapshotBinding(snapshotBindings, snapshot).enrollment
      )
      snapshotDecisions.set(snapshot, decision)
      return decision
    },
    async preflight(action, snapshot, ledger, context) {
      const binding = requireObjectiveSnapshotBinding(snapshotBindings, snapshot)
      return objectivePreflight({
        action,
        snapshot,
        ledger,
        enrollment: context.enrollment,
        target: binding.target
      })
    },
    execute: executor.execute,
    resolveOutcome: executor.resolveOutcome,
    stopPredicates: OBJECTIVE_STOP_PREDICATES,
    pacing: {
      pace(snapshot, ledger) {
        const decision =
          snapshotDecisions.get(snapshot) ??
          decideObjectiveForEnrollment(
            snapshot,
            ledger,
            requireObjectiveSnapshotBinding(snapshotBindings, snapshot).enrollment
          )
        snapshotDecisions.delete(snapshot)
        return paceObjectiveForEnrollment(snapshot, ledger, decision)
      }
    },
    planner: {},
    handoff: objectiveHandoffAdapter(args.objectiveStore),
    debug: {
      pointers: () => [
        {
          role: 'kind-database',
          host: 'kernel',
          path: args.objectiveStore.databasePath(),
          status: 'resolved'
        }
      ]
    }
  }
}
