import type { Finding, FindingSeverity } from './finding-schema'
import type { PrepassStatus } from './prepass-result-schema'
import type { ReviewProfile, ReviewVerdict } from './stage-schemas'

export const VERDICT_EXIT_CODE: Readonly<Record<ReviewVerdict, number>> = {
  PASS: 0,
  NEEDS_FIXES: 1,
  CRITICAL_ISSUES: 3,
  NOT_REVIEWABLE: 4
}

export function effectiveSeverity(
  finding: Pick<Finding, 'severity' | 'adjudicated_severity'>
): FindingSeverity {
  return finding.adjudicated_severity ?? finding.severity
}

export function isBlocking(
  finding: Pick<Finding, 'severity' | 'adjudicated_severity' | 'confidence' | 'stage'>
): boolean {
  const severity = effectiveSeverity(finding)
  if (severity === 'LOW') {
    return false
  }
  if (severity === 'CRITICAL') {
    return true
  }
  return !(finding.confidence === 'LOW' && finding.stage === 'promote')
}

export type Reviewability = {
  reviewerResolved: boolean
  artifactCaptured: boolean
  prepassStatus: PrepassStatus
  profile: ReviewProfile
}

export type VerdictInput = Reviewability & {
  findings: readonly Finding[]
  contested?: readonly Finding[]
}

/** A contested deep gate deliberately has no verdict until tiebreak settles it. */
export function computeVerdict(input: VerdictInput): ReviewVerdict | null {
  if (!input.reviewerResolved || !input.artifactCaptured) {
    return 'NOT_REVIEWABLE'
  }
  if (input.profile === 'code-diff' && input.prepassStatus === 'could-not-run') {
    return 'NOT_REVIEWABLE'
  }
  if ((input.contested?.length ?? 0) > 0) {
    return null
  }

  const severities = new Set(
    input.findings.filter(isBlocking).map((finding) => effectiveSeverity(finding))
  )
  if (severities.has('CRITICAL')) {
    return 'CRITICAL_ISSUES'
  }
  if (severities.has('HIGH') || severities.has('MEDIUM')) {
    return 'NEEDS_FIXES'
  }
  return 'PASS'
}

export function verdictExitCode(verdict: ReviewVerdict): number {
  return VERDICT_EXIT_CODE[verdict]
}
