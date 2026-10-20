import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import { getInFlightHostedReviewAttempts } from '../fork-hosted-review-sitter/ledger-adapter'
import type { ObjectiveDetail } from '../fork-heimdall-objective/detail-types'

type ObjectiveDisplayPhase =
  | 'planning'
  | 'plan-review'
  | 'running-tasks'
  | 'checks'
  | 'review'
  | 'landing'
  | 'landed'

function phaseFromTrace(tracePhase: string | null): ObjectiveDisplayPhase | null {
  switch (tracePhase) {
    case 'planning':
    case 'plan':
      return 'planning'
    case 'plan-review':
    case 'plan-review-in-flight':
      return 'plan-review'
    case 'implementation':
      return 'running-tasks'
    case 'checks':
    case 'gates':
    case 'check-in-flight':
    case 'gate-in-flight':
      return 'checks'
    case 'review':
    case 'review-in-flight':
      return 'review'
    case 'landing':
    case 'landing-in-flight':
      return 'landing'
    case 'landed':
      return 'landed'
    case null:
      return null
    default:
      return null
  }
}

function hasStaleChecks(detail: ObjectiveDetail, revisionId: string): boolean {
  const criterionChecksStale = detail.nodes.some(
    (node) =>
      node.revisionId === revisionId &&
      node.criteria.some((criterion) => criterion.shellCheckable && criterion.lastCheck === null)
  )
  const shellGatesStale = detail.gates?.some((gate) => gate.lastResult === undefined) ?? false
  return criterionChecksStale || shellGatesStale
}

/** Returns the Objective composite's display phase, or `unknown` when its phase cannot be read. */
export function objectiveCompositePhase(
  detail: ObjectiveDetail | null,
  tracePhase: string | null
): string {
  const tracedPhase = phaseFromTrace(tracePhase)
  if (tracedPhase === 'plan-review') {
    return tracedPhase
  }
  if (!detail) {
    return tracedPhase ?? 'unknown'
  }

  const approvedRevision = detail.revisions.find((revision) => revision.status === 'approved')
  if (!approvedRevision) {
    return 'planning'
  }

  if (tracedPhase === 'landing' || tracedPhase === 'landed') {
    return tracedPhase
  }

  const revisionNodes = detail.nodes.filter((node) => node.revisionId === approvedRevision.id)
  if (
    revisionNodes.some((node) => node.state !== 'succeeded' && node.state !== 'replanned') ||
    tracedPhase === 'running-tasks'
  ) {
    return 'running-tasks'
  }

  if (tracedPhase === 'checks' || hasStaleChecks(detail, approvedRevision.id)) {
    return 'checks'
  }
  if (tracedPhase === 'review') {
    return 'review'
  }
  return 'unknown'
}

/** Returns the display phase implied by hosted-review actions currently in flight. */
export function sitterCompositePhase(ledger: WatcherLedger): string {
  const attempts = getInFlightHostedReviewAttempts(ledger)
  const action = attempts.at(-1)?.action
  if (!action) {
    return 'watching'
  }

  switch (action.kind) {
    case 'rerun-check':
    case 'prepare-fix':
    case 'publish-fix':
      return 'fixing-checks'
    case 'prepare-conflict-resolution':
    case 'publish-conflict-resolution':
      return 'resolving-conflicts'
    case 'update-branch':
      return 'updating-branch'
    case 'merge':
    case 'enqueue':
      return 'merging'
  }
}
