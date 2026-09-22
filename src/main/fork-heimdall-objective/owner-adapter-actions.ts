import type { Intervention } from '../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { activeObjectiveRevision } from '../../shared/fork-heimdall-objective/decision-context'
import {
  OWNER_SKIP_REVIEW_DISPATCH_PREFIX,
  type DispatchPlannerAction,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import type {
  ObjectiveNodeProjection,
  ObjectiveWorld
} from '../../shared/fork-heimdall-objective/detail-types'
import { lineageBaseIdentity } from '../../shared/fork-heimdall-objective/landing-ladder'
import { ObjectiveSpecificInterventionSchema } from '../../shared/fork-heimdall-objective/owner-intervention'
import { objectiveResultDigest } from './execution-context'

function findNodeForTask(world: ObjectiveWorld, taskKey: string): ObjectiveNodeProjection | null {
  const active = activeObjectiveRevision(world)
  return (
    world.plan.nodes.find((node) => node.taskKey === taskKey && node.revisionId === active?.id) ??
    world.plan.nodes.find((node) => node.taskKey === taskKey) ??
    null
  )
}

/** The revision an owner move against a taskKey applies to; falls back to the active revision so a
 *  stale or unknown taskKey still yields a syntactically valid action for the executor to refuse. */
function resolveRevisionId(world: ObjectiveWorld, node: ObjectiveNodeProjection | null): string {
  return node?.revisionId ?? activeObjectiveRevision(world)?.id ?? 'unknown-revision'
}

function resolveDepsOrchestrationIds(
  world: ObjectiveWorld,
  revisionId: string,
  deps: readonly string[]
): string[] {
  const byKey = new Map(
    world.plan.nodes
      .filter((node) => node.revisionId === revisionId)
      .map((node) => [node.taskKey, node])
  )
  const ids: string[] = []
  for (const dep of deps) {
    const orchestrationTaskId = byKey.get(dep)?.orchestrationTaskId
    if (orchestrationTaskId) {
      ids.push(orchestrationTaskId)
    }
  }
  return ids
}

/**
 * The owner's own free-text steer, reused for a genuine `dispatch-planner` intervention and as the
 * fallback for `skip-stage` and `set-role-agent`, neither of which has a mid-flight action target
 * of its own — the planner is the only always-available way to carry the owner's intent forward.
 */
function ownerGuidancePlannerAction(
  world: ObjectiveWorld,
  snapshot: Snapshot<ObjectiveWorld>,
  guidance: string,
  requestedSkipStage?: string
): DispatchPlannerAction {
  const nextNumber =
    world.plan.revisions.reduce((max, revision) => Math.max(max, revision.number), 0) + 1
  return {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: snapshot.contentIdentity,
    evidenceKey: `plan:${nextNumber}:owner-directed:${snapshot.contentIdentity}`,
    revisionNumber: nextNumber,
    reason: 'owner-directed',
    guidance,
    ...(requestedSkipStage === undefined ? {} : { requestedSkipStage })
  }
}

/** Translates a validated objective-specific intervention into the write-ahead action `execute` applies. */
export function objectiveActionForIntervention(
  intervention: Intervention,
  snapshot: Snapshot<ObjectiveWorld>
): ObjectiveAction {
  const parsed = ObjectiveSpecificInterventionSchema.parse(intervention)
  const world = snapshot.world

  switch (parsed.kind) {
    case 'accept-report': {
      const node = findNodeForTask(world, parsed.taskKey)
      return {
        kind: 'accept-report',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `accept-report:${parsed.dispatchId}`,
        recovery: 'replay-safe',
        revisionId: resolveRevisionId(world, node),
        taskKey: parsed.taskKey,
        dispatchId: parsed.dispatchId,
        attestation: parsed.attestation
      }
    }
    case 'retry-node': {
      const node = findNodeForTask(world, parsed.taskKey)
      const revisionId = resolveRevisionId(world, node)
      return {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `${revisionId}:${parsed.taskKey}:owner-retry:${snapshot.contentIdentity}`,
        revisionId,
        taskKey: parsed.taskKey,
        depsOrchestrationIds: resolveDepsOrchestrationIds(world, revisionId, node?.deps ?? []),
        retryOf: `${revisionId}:${parsed.taskKey}`,
        ...(parsed.amendedSpec === undefined ? {} : { ownerAmendedSpec: parsed.amendedSpec }),
        ...(parsed.agent === undefined ? {} : { ownerAgent: parsed.agent })
      }
    }
    case 'skip-node': {
      const node = findNodeForTask(world, parsed.taskKey)
      const revisionId = resolveRevisionId(world, node)
      const digest = objectiveResultDigest({
        kind: 'owner-skip-node',
        revisionId,
        taskKey: parsed.taskKey,
        rationale: parsed.rationale
      })
      return {
        kind: 'amend-plan',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `amend-plan:${digest}`,
        recovery: 'replay-safe',
        revisionId,
        patch: {
          digest,
          attestation: parsed.rationale,
          upsertTasks: [],
          dropTaskKeys: [parsed.taskKey]
        },
        attestation: parsed.rationale
      }
    }
    case 'amend-plan':
      return {
        kind: 'amend-plan',
        capability: 'plan',
        visibility: 'local',
        contentIdentity: snapshot.contentIdentity,
        evidenceKey: `amend-plan:${parsed.patch.digest}`,
        recovery: 'replay-safe',
        revisionId: parsed.revisionId,
        patch: parsed.patch,
        attestation: parsed.attestation
      }
    case 'dispatch-planner':
      return ownerGuidancePlannerAction(world, snapshot, parsed.guidance)
    case 'skip-stage': {
      if (parsed.stage === 'reviewer' || parsed.stage === 'integrator') {
        const revisionId = activeObjectiveRevision(world)?.id ?? 'unknown-revision'
        const reviewedContentIdentity = lineageBaseIdentity(
          world.plan.landing,
          snapshot.contentIdentity
        )
        const dispatchId = `${OWNER_SKIP_REVIEW_DISPATCH_PREFIX}${revisionId}:${parsed.stage}:${reviewedContentIdentity}`
        return {
          kind: 'skip-review',
          capability: 'review',
          visibility: 'local',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: `skip-review:${dispatchId}`,
          recovery: 'replay-safe',
          revisionId,
          role: parsed.stage,
          dispatchId,
          reviewedContentIdentity,
          rationale: parsed.rationale
        }
      }
      if (parsed.stage === 'checks' && parsed.criterionId !== undefined) {
        return {
          kind: 'skip-check',
          capability: 'check',
          visibility: 'local',
          contentIdentity: snapshot.contentIdentity,
          evidenceKey: `${parsed.criterionId}:${snapshot.contentIdentity}`,
          recovery: 'replay-safe',
          criterionId: parsed.criterionId,
          rationale: parsed.rationale
        }
      }
      // a landing-ladder rung has no forgeable evidence to fabricate; gate 2 refuses every
      // mandated one anyway, so this only ever runs for a rung the bar never required in the
      // first place, where the pipeline was never going to try to reach it regardless
      return ownerGuidancePlannerAction(world, snapshot, parsed.rationale, parsed.stage)
    }
    case 'set-role-agent':
      return ownerGuidancePlannerAction(
        world,
        snapshot,
        `Prefer agent "${parsed.agent}" for the ${parsed.role} role going forward.`
      )
  }
}
