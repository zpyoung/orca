import type { GateVerdict } from '../fork-heimdall/gate'
import type {
  HostedReviewSitterAction,
  HostedReviewSitterContention,
  HostedReviewSitterDefinition,
  HostedReviewWorldSnapshot
} from './types'

const ALLOW: GateVerdict = { verdict: 'allow' }

/** Contention matters only when this provider/action path mutates the checked-out worktree. */
export function actionWritesWorktree(
  action: HostedReviewSitterAction,
  sitter: HostedReviewSitterDefinition
): boolean {
  switch (action.kind) {
    case 'prepare-fix':
    case 'publish-fix':
    case 'prepare-conflict-resolution':
    case 'publish-conflict-resolution':
      return true
    case 'update-branch':
      return sitter.provider === 'gitlab' || action.mode === 'rebase'
    case 'rerun-check':
    case 'merge':
    case 'enqueue':
      return false
  }
}

export function hostedReviewPreflight(
  action: HostedReviewSitterAction,
  snapshot: HostedReviewWorldSnapshot,
  contention: HostedReviewSitterContention
): GateVerdict {
  const { definition, review } = snapshot.world
  if (
    review.provider !== definition.provider ||
    review.reviewNumber !== definition.reviewNumber ||
    review.url !== definition.reviewUrl ||
    action.reviewUrl !== definition.reviewUrl
  ) {
    return { verdict: 'escalate', reason: 'review-identity-mismatch' }
  }
  if (!actionWritesWorktree(action, definition)) {
    return ALLOW
  }

  switch (contention.state) {
    case 'clear':
      return ALLOW
    case 'dirty':
      return { verdict: 'hold', reason: 'local-changes' }
    case 'foreign-agent':
      return { verdict: 'hold', reason: 'foreign-agent' }
    case 'sitter-fix-agent':
      return { verdict: 'hold', reason: 'action-in-flight' }
    case 'unverifiable':
      return { verdict: 'hold', reason: 'contention-unverifiable' }
    case 'abandoned-sitter-fix':
      return { verdict: 'escalate', reason: 'abandoned-fix' }
  }
}
