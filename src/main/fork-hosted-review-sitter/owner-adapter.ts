import type {
  OwnerAdapter,
  OwnerInterventionRejection
} from '../../shared/fork-heimdall/kind-contract'
import type { Intervention } from '../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { makeHostedReviewEvidenceKey } from '../../shared/fork-hosted-review-sitter/action-identity'
import {
  buildMergeAction,
  buildPrepareConflictAction,
  buildPrepareFixAction,
  buildRerunAction,
  buildUpdateAction
} from '../../shared/fork-hosted-review-sitter/decision-action-builders'
import {
  deterministicFailureChecks,
  failedCheckGroups
} from '../../shared/fork-hosted-review-sitter/decision-check-groups'
import {
  describeHostedReviewInterventions,
  HostedReviewSitterInterventionSchema,
  RUNG_CAPABILITY,
  type HostedReviewRetriableRung,
  type HostedReviewSitterSpecificIntervention
} from '../../shared/fork-hosted-review-sitter/owner-intervention'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterCapability,
  HostedReviewSnapshot,
  HostedReviewWorld
} from '../../shared/fork-hosted-review-sitter/types'
import { describeHostedReviewOwnerState } from './owner-state-brief'

/** An owner may not grant a capability the enrollment withheld, and never unattended merge. */
function rejectCapabilityGrant(
  capability: HostedReviewSitterCapability,
  enrollment: WatcherEnrollment
): OwnerInterventionRejection | null {
  if (capability === 'merge') {
    return { gate: 'sitter-overrides', reason: 'An owner may not grant unattended merge.' }
  }
  const mode = enrollment.capabilities[capability] ?? 'off'
  return mode === 'off'
    ? { gate: 'sitter-overrides', reason: `The enrollment withheld the ${capability} capability.` }
    : null
}

function isHostedReviewSitterSpecificIntervention(
  intervention: Intervention
): intervention is HostedReviewSitterSpecificIntervention {
  return intervention.kind === 'retry-rung' || intervention.kind === 'skip-capability'
}

function firstFailedGroup(review: HostedReviewSnapshot) {
  const group = failedCheckGroups(review)[0]
  if (!group) {
    throw new Error('No failing required check to act on')
  }
  return group
}

/** Builds each retriable rung's action purely from the snapshot; ledger facts are unavailable here. */
function baseRungAction(
  rung: HostedReviewRetriableRung,
  world: HostedReviewWorld
): HostedReviewSitterAction {
  switch (rung) {
    case 'rerun-check':
      return buildRerunAction(world.review, firstFailedGroup(world.review))
    case 'prepare-fix': {
      const group = firstFailedGroup(world.review)
      const built = buildPrepareFixAction(
        world.review,
        group.checkKey,
        deterministicFailureChecks(group) ?? group.checks,
        'same-shard-multi-node'
      )
      if (!built) {
        throw new Error('No check in the failing group carries a usable failure signature')
      }
      return built
    }
    case 'prepare-conflict-resolution':
      return buildPrepareConflictAction(world.review)
    case 'update-branch':
      return buildUpdateAction(world.review, world.definition)
    case 'merge':
    case 'enqueue': {
      const built = buildMergeAction(world.review, world.definition)
      if (!built) {
        throw new Error('Nothing to merge or enqueue right now')
      }
      return built
    }
  }
}

function skipCapabilityAction(
  capability: Exclude<HostedReviewSitterCapability, 'merge'>,
  world: HostedReviewWorld
): HostedReviewSitterAction {
  switch (capability) {
    case 'updateBranch':
      return buildUpdateAction(world.review, world.definition)
    case 'resolveConflicts':
      return buildPrepareConflictAction(world.review)
    case 'fixChecks':
      return buildRerunAction(world.review, firstFailedGroup(world.review))
  }
}

/**
 * The hosted-review sitter's owner seam: a strict retry-rung/skip-capability vocabulary on top of
 * the four kind-agnostic moves, gated so an owner can never exceed what the enrollment granted.
 */
export function createHostedReviewOwnerAdapter(): OwnerAdapter<
  HostedReviewWorld,
  HostedReviewSitterAction
> {
  return {
    describeState: describeHostedReviewOwnerState,
    describeInterventions: describeHostedReviewInterventions,
    interventionSchema: HostedReviewSitterInterventionSchema,
    rejectIntervention(intervention, _snapshot, _ledger, enrollment) {
      if (!isHostedReviewSitterSpecificIntervention(intervention)) {
        throw new Error('Hosted review owner adapter received a non-sitter intervention.')
      }
      return intervention.kind === 'skip-capability'
        ? rejectCapabilityGrant(intervention.capability, enrollment)
        : rejectCapabilityGrant(RUNG_CAPABILITY[intervention.rung], enrollment)
    },
    actionForIntervention(intervention, snapshot: Snapshot<HostedReviewWorld>) {
      if (!isHostedReviewSitterSpecificIntervention(intervention)) {
        throw new Error('Hosted review owner adapter received a non-sitter intervention.')
      }
      if (intervention.kind === 'skip-capability') {
        if (intervention.capability === 'merge') {
          throw new Error('skip-capability for merge is always rejected before this point')
        }
        return skipCapabilityAction(intervention.capability, snapshot.world)
      }
      const base = baseRungAction(intervention.rung, snapshot.world)
      return {
        ...base,
        evidenceKey: makeHostedReviewEvidenceKey([
          'owner-retry',
          intervention.rung,
          snapshot.world.review.headSha,
          intervention.rationale
        ])
      }
    }
  }
}
