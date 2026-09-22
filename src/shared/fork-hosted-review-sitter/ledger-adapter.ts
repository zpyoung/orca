import {
  getAttemptDisposition,
  type AttemptDisposition
} from '../fork-heimdall/attempt-fingerprint'
import {
  getInFlightAttempts,
  getLatestAttemptForFingerprint,
  getLatestAttempts,
  getLatestEscalations,
  getUnresolvedAttempts
} from '../fork-heimdall/ledger-queries'
import type {
  AttemptEntry,
  EscalationEntry,
  KernelAction,
  WatcherLedger
} from '../fork-heimdall/ledger-types'
import { hostedReviewAttemptFingerprint } from './action-identity'
import type {
  HostedReviewAttemptEntry,
  HostedReviewFixAttribution,
  HostedReviewSitterAction,
  HostedReviewSitterActionKind,
  HostedReviewSitterActionResult
} from './types'

const HOSTED_REVIEW_ACTION_KINDS: Record<HostedReviewSitterActionKind, true> = {
  'rerun-check': true,
  'prepare-fix': true,
  'publish-fix': true,
  'prepare-conflict-resolution': true,
  'publish-conflict-resolution': true,
  'update-branch': true,
  merge: true,
  enqueue: true
}

function isHostedReviewAction(action: KernelAction): action is HostedReviewSitterAction {
  return (
    HOSTED_REVIEW_ACTION_KINDS[action.kind as HostedReviewSitterActionKind] === true &&
    typeof action.headSha === 'string' &&
    typeof action.reviewUrl === 'string'
  )
}

function isHostedReviewActionResult(value: unknown): value is HostedReviewSitterActionResult {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return false
  }
  const result = value as Record<string, unknown>
  switch (result.kind) {
    case 'none':
    case 'rerun-requested':
      return true
    case 'worker-dispatched':
      return typeof result.dispatchId === 'string'
    case 'published':
      return typeof result.resultingHeadSha === 'string'
    default:
      return false
  }
}

function asHostedReviewAttempt(entry: AttemptEntry): HostedReviewAttemptEntry | null {
  if (!isHostedReviewAction(entry.action)) {
    return null
  }
  if (entry.result !== undefined && !isHostedReviewActionResult(entry.result)) {
    return null
  }
  return entry as HostedReviewAttemptEntry
}

export function getLatestHostedReviewAttempts(
  ledger: WatcherLedger
): readonly HostedReviewAttemptEntry[] {
  return getLatestAttempts(ledger)
    .map(asHostedReviewAttempt)
    .filter((entry): entry is HostedReviewAttemptEntry => entry !== null)
}

export function getHostedReviewAttemptDisposition(
  ledger: WatcherLedger,
  action: HostedReviewSitterAction
): AttemptDisposition {
  return getAttemptDisposition(ledger, hostedReviewAttemptFingerprint(action))
}

export function getCompletedHostedReviewAttempt(
  ledger: WatcherLedger,
  action: HostedReviewSitterAction
): HostedReviewAttemptEntry | null {
  if (getHostedReviewAttemptDisposition(ledger, action) !== 'completed') {
    return null
  }
  const entry = getLatestAttemptForFingerprint(ledger, hostedReviewAttemptFingerprint(action))
  return entry ? asHostedReviewAttempt(entry) : null
}

/** The dispatch a worker-backed action's latest ledger attempt ran under, if any. */
export function getHostedReviewAttemptDispatchId(
  ledger: WatcherLedger,
  action: HostedReviewSitterAction
): string | null {
  return (
    getLatestAttemptForFingerprint(ledger, hostedReviewAttemptFingerprint(action))?.dispatchId ??
    null
  )
}

export function getUnresolvedHostedReviewAttempts(
  ledger: WatcherLedger
): readonly HostedReviewAttemptEntry[] {
  return getUnresolvedAttempts(ledger)
    .map(asHostedReviewAttempt)
    .filter((entry): entry is HostedReviewAttemptEntry => entry !== null)
}

export function getInFlightHostedReviewAttempts(
  ledger: WatcherLedger
): readonly HostedReviewAttemptEntry[] {
  return getInFlightAttempts(ledger)
    .map(asHostedReviewAttempt)
    .filter((entry): entry is HostedReviewAttemptEntry => entry !== null)
}

/**
 * True when some in-flight attempt matches, independent of its evidenceKey. An owner's retry-rung
 * mints a fresh evidenceKey for the same kind/head, so the canonical fingerprint stays `unresolved`
 * while the retry is running; deciding by fingerprint alone would re-deviate on top of it.
 */
export function hasInFlightHostedReviewAttemptMatching(
  ledger: WatcherLedger,
  match: (action: HostedReviewSitterAction) => boolean
): boolean {
  return getInFlightHostedReviewAttempts(ledger).some((entry) => match(entry.action))
}

export function getHostedReviewEscalations(ledger: WatcherLedger): readonly EscalationEntry[] {
  return getLatestEscalations(ledger)
}

function isHostedReviewFixAttribution(value: unknown): value is HostedReviewFixAttribution {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Record<string, unknown>
  return (
    typeof payload.sourceHeadSha === 'string' &&
    typeof payload.producedHeadSha === 'string' &&
    typeof payload.preparedCommitSha === 'string' &&
    typeof payload.checkKey === 'string' &&
    typeof payload.failureSignature === 'string' &&
    typeof payload.publishActionId === 'string'
  )
}

export function getHostedReviewFixAttributions(
  ledger: WatcherLedger
): readonly HostedReviewFixAttribution[] {
  return ledger.entries.flatMap((entry) =>
    entry.kind === 'evidence' &&
    entry.evidenceKind === 'fix-attribution' &&
    isHostedReviewFixAttribution(entry.payload)
      ? [entry.payload]
      : []
  )
}
