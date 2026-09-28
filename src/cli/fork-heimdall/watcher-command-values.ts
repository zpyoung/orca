import type { ApprovalScope, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  getLatestEscalations,
  getLatestUnresolvedAwaitingApprovalEscalation
} from '../../shared/fork-heimdall/ledger-queries'
import { RuntimeClientError } from '../runtime/types'

export function latestApprovalScopeForEscalation(
  ledger: WatcherLedger,
  escalationId: string
): ApprovalScope | null {
  const escalation = getLatestEscalations(ledger).find(
    (entry) => entry.escalationId === escalationId
  )
  if (
    !escalation ||
    (escalation.status !== 'open' && escalation.status !== 'escalated') ||
    escalation.escalationKind !== 'awaiting-approval' ||
    escalation.approvalScope === undefined
  ) {
    return null
  }
  const latestForScope = getLatestUnresolvedAwaitingApprovalEscalation(
    ledger,
    escalation.approvalScope
  )
  return latestForScope?.escalationId === escalationId ? escalation.approvalScope : null
}

export function parseBudgetHours(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === 'none') {
    return null
  }
  if (!/^\d+(?:\.\d+)?$/u.test(value)) {
    throw new RuntimeClientError('invalid_argument', '--hours must be non-negative hours or none')
  }
  const milliseconds = Number(value) * 3_600_000
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--hours must resolve to a whole, safe number of milliseconds'
    )
  }
  return milliseconds
}

export function parseBudgetTurns(value: string | undefined): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === 'none') {
    return null
  }
  if (!/^\d+$/u.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--turns must be a non-negative integer or none'
    )
  }
  const turns = Number(value)
  if (!Number.isSafeInteger(turns)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--turns must be a safe non-negative integer or none'
    )
  }
  return turns
}

export function parseWatcherConcurrency(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--max-concurrency must be a whole number from 1 to 1024'
    )
  }
  const maxConcurrency = Number(value)
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency > 1_024) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--max-concurrency must be a whole number from 1 to 1024'
    )
  }
  return maxConcurrency
}

export function requireAnswerText(value: string, flag: string, maximum?: number): string {
  const answer = value.trim()
  if (answer.length === 0 || (maximum !== undefined && answer.length > maximum)) {
    const constraint =
      maximum === undefined ? 'must not be empty' : `must be 1 to ${maximum} characters`
    throw new RuntimeClientError('invalid_argument', `--${flag} ${constraint}`)
  }
  return answer
}
