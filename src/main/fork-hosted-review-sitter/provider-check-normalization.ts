import { createHash } from 'node:crypto'
import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { HostedReviewCheckState } from '../../shared/fork-hosted-review-sitter/types'

export type HostedReviewCheckIdentity = {
  checkKey: string
  shardKey?: string
  runtimeKey?: string
}

export function deriveHostedReviewCheckIdentity(name: string): HostedReviewCheckIdentity {
  const matrix = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/)
  if (!matrix) {
    return { checkKey: name }
  }
  const dimensions = matrix[2]!
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const runtime = dimensions.find((value) =>
    /^(?:node(?:\.js)?|runtime)\s*[:=]?\s*v?\d/i.test(value)
  )
  const shards = dimensions.filter((value) => value !== runtime)
  return {
    checkKey: matrix[1]!.trim() || name,
    ...(shards.length > 0 ? { shardKey: shards.join(', ') } : {}),
    ...(runtime ? { runtimeKey: runtime } : {})
  }
}

export function githubCheckState(status: unknown, conclusion: unknown): HostedReviewCheckState {
  const normalizedStatus = typeof status === 'string' ? status.toUpperCase() : ''
  const normalizedConclusion = typeof conclusion === 'string' ? conclusion.toUpperCase() : ''
  if (normalizedStatus && normalizedStatus !== 'COMPLETED') {
    return 'pending'
  }
  if (
    normalizedConclusion === 'SUCCESS' ||
    normalizedConclusion === 'NEUTRAL' ||
    normalizedConclusion === 'SKIPPED'
  ) {
    return 'passed'
  }
  if (normalizedConclusion === 'CANCELLED') {
    return 'cancelled'
  }
  if (
    ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(
      normalizedConclusion
    )
  ) {
    return 'failed'
  }
  return normalizedStatus === 'COMPLETED' ? 'unknown' : 'pending'
}

export function githubStatusContextState(state: unknown): HostedReviewCheckState {
  switch (typeof state === 'string' ? state.toUpperCase() : '') {
    case 'SUCCESS':
      return 'passed'
    case 'FAILURE':
    case 'ERROR':
      return 'failed'
    case 'EXPECTED':
    case 'PENDING':
      return 'pending'
    default:
      return 'unknown'
  }
}

export function gitlabJobState(status: unknown): HostedReviewCheckState {
  switch (typeof status === 'string' ? status.toLowerCase() : '') {
    case 'success':
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'cancelled'
    case 'skipped':
      return 'skipped'
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'running':
    case 'scheduled':
    case 'manual':
      return 'pending'
    default:
      return 'unknown'
  }
}

function normalizeFailureEvidence(value: string): string {
  return stripAnsiEscapeSequences(value)
    .replace(/\b\d{4}-\d\d-\d\d[T ][0-9:.+-]+Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{40,64}\b/gi, '<sha>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<uuid>')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-400)
    .join('\n')
    .trim()
}

export function stableFailureSignature(
  checkKey: string,
  evidence: readonly string[]
): string | null {
  const normalized = normalizeFailureEvidence(evidence.filter(Boolean).join('\n'))
  if (!normalized) {
    return null
  }
  return `sha256:${createHash('sha256').update(checkKey).update('\0').update(normalized).digest('hex')}`
}
