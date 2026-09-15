import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type { WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentPayloadSchema } from '../../shared/fork-heimdall-objective/contract-types'
import { decideObjective } from '../../shared/fork-heimdall-objective/decision'
import {
  ObjectiveWorldSchema,
  type ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { objectivePacing } from '../../shared/fork-heimdall-objective/pacing'
import { OBJECTIVE_STOP_PREDICATES } from '../../shared/fork-heimdall-objective/stop-policy'
import type { Store } from '../persistence'
import { runtimeFileSshTargetId } from '../runtime/runtime-file-command-target'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { createObjectiveActionExecutor } from './action-executor'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { authorizeObjectiveEnrollment, objectiveContractFromEnrollment } from './definition'
import {
  bindObjectiveSnapshot,
  requireObjectiveSnapshotBinding,
  type ObjectiveSnapshotBinding
} from './execution-context'
import type { ObjectiveStore } from './objective-store'
import { resolveObjectiveWorkspaceTarget } from './workspace-target'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'

export type ObjectiveKind = WatcherKind<ObjectiveWorld, ObjectiveAction, ObjectiveEnrollmentPayload>

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
  const currentLanding = snapshot.world.plan.landing.some(
    (entry) => entry.contentIdentity === snapshot.contentIdentity
  )
  if (currentLanding) {
    return 'landed'
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

export function createObjectiveKind(args: {
  runtime: OrcaRuntimeService
  store: Store
  objectiveStore: ObjectiveStore
  storageAuthority?: 'desktop' | 'runtime'
}): ObjectiveKind {
  const snapshotBindings = new WeakMap<Snapshot<ObjectiveWorld>, ObjectiveSnapshotBinding>()
  const executor = createObjectiveActionExecutor({
    store: args.store,
    objectiveStore: args.objectiveStore,
    snapshotBindings
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
        args.storageAuthority ?? 'desktop'
      ),
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
      const world = ObjectiveWorldSchema.parse({
        contract,
        workspaceKind: target.kind,
        plan: args.objectiveStore.project(enrollment.watcherId, undefined, contentIdentity),
        reports: [],
        budget: enrollment.budget
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
        phase: objectivePhase(snapshot)
      }
    },
    decide: decideObjective,
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
    pacing: objectivePacing,
    planner: {}
  }
}
