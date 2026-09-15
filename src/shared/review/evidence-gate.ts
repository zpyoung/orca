import { FindingSchema, type Evidence, type Finding, type FindingSeverity } from './finding-schema'
import { GateResultSchema, type GateResult, type SuppressedFinding } from './gate-result-schema'
import type { PrepassStatus } from './prepass-result-schema'
import type { Chain, ReviewDepth, ReviewProfile } from './stage-schemas'
import { computeVerdict, effectiveSeverity, isBlocking } from './verdict'

export type EvidenceResolver = (evidence: Evidence, finding: Finding) => boolean

export type EvidenceGateResult = {
  finding: Finding | null
  reason: 'falsified' | null
}

function evidenceHoldsByShape(evidence: Evidence): boolean {
  if (evidence.kind === 'absence') {
    return evidence.output.trim().length === 0
  }
  return true
}

/** Applies only demonstrable evidence failures; command evidence is never re-run here. */
export function applyEvidenceGate(
  findingInput: Finding,
  options: { fromPrepass?: boolean; resolves?: EvidenceResolver } = {}
): EvidenceGateResult {
  const finding = FindingSchema.parse(findingInput)
  const resolves = options.resolves ?? (() => true)
  if (
    !finding.evidence.every((evidence) => {
      if (!evidenceHoldsByShape(evidence)) {
        return false
      }
      if (evidence.kind === 'command' || evidence.kind === 'prepass') {
        return true
      }
      return resolves(evidence, finding)
    })
  ) {
    return { finding: null, reason: 'falsified' }
  }

  const reproductionKinds = options.fromPrepass
    ? new Set(['command', 'prepass'])
    : new Set(['command'])
  const hasReproduction = finding.evidence.some((evidence) => reproductionKinds.has(evidence.kind))
  if (!hasReproduction && (finding.severity === 'CRITICAL' || finding.severity === 'HIGH')) {
    return { finding: { ...finding, confidence: 'LOW' }, reason: null }
  }
  return { finding, reason: null }
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3
}

function compareFindings(left: Finding, right: Finding): number {
  const leftUnfalsifiable = left.category === 'unfalsifiable-claim'
  const rightUnfalsifiable = right.category === 'unfalsifiable-claim'
  if (leftUnfalsifiable !== rightUnfalsifiable) {
    return leftUnfalsifiable ? -1 : 1
  }
  return SEVERITY_RANK[effectiveSeverity(left)] - SEVERITY_RANK[effectiveSeverity(right)]
}

function assignFindingIds(findings: Finding[], reserved: Set<string>): void {
  const supplied = findings.flatMap((finding) => (finding.id ? [finding.id] : []))
  const duplicate = supplied.find((id, index) => supplied.indexOf(id) !== index)
  if (duplicate) {
    throw new Error(`findings carry duplicate id: ${duplicate}`)
  }
  const taken = new Set([...reserved, ...supplied])
  let next = 1
  for (const finding of findings) {
    if (finding.id) {
      continue
    }
    while (taken.has(`F${next}`)) {
      next += 1
    }
    finding.id = `F${next}`
    taken.add(finding.id)
  }
}

export type GateReviewability = {
  reviewerResolved: boolean
  artifactCaptured: boolean
  prepassStatus: PrepassStatus
  profile: ReviewProfile
}

export type GateSuppressedInput = Omit<SuppressedFinding, 'id'> & { id?: string }

export type EvaluateEvidenceGateInput = GateReviewability & {
  depth: ReviewDepth
  findings: readonly Finding[]
  prepassFindings?: readonly Finding[]
  carriedSuppressed?: readonly GateSuppressedInput[]
  dismissedPriorIds?: ReadonlySet<string>
  resolvesEvidence?: EvidenceResolver
  unreviewedPaths?: readonly string[]
  chain: Chain
}

/** Pure port of the pinned gate: merge, grade, suppress, classify, then map the verdict. */
export function evaluateEvidenceGate(input: EvaluateEvidenceGateInput): GateResult {
  const mergedEntries = [
    ...input.findings.map((finding) => ({
      finding: FindingSchema.parse(finding),
      fromPrepass: false
    })),
    ...(input.prepassFindings ?? []).map((finding) => ({
      finding: FindingSchema.parse(finding),
      fromPrepass: true
    }))
  ].sort((left, right) => compareFindings(left.finding, right.finding))
  const merged = mergedEntries.map((entry) => entry.finding)
  const carriedSuppressed = (input.carriedSuppressed ?? []).map((entry) => ({ ...entry }))
  const suppliedSuppressedIds = carriedSuppressed.flatMap((entry) => (entry.id ? [entry.id] : []))
  if (new Set(suppliedSuppressedIds).size !== suppliedSuppressedIds.length) {
    throw new Error('carried suppressions carry duplicate ids')
  }
  assignFindingIds(merged, new Set(suppliedSuppressedIds))
  const taken = new Set(merged.map((finding) => finding.id!))
  let nextSuppressedId = 1
  for (const entry of carriedSuppressed) {
    if (entry.id) {
      continue
    }
    while (taken.has(`F${nextSuppressedId}`)) {
      nextSuppressedId += 1
    }
    entry.id = `F${nextSuppressedId}`
    taken.add(entry.id)
  }
  const suppressed: SuppressedFinding[] = carriedSuppressed.map((entry) => ({
    ...entry,
    id: entry.id!
  }))

  const survivors: Finding[] = []
  const limitations: Finding[] = []
  const questions: Finding[] = []
  const contested: Finding[] = []
  for (let index = 0; index < mergedEntries.length; index += 1) {
    const { finding, fromPrepass } = mergedEntries[index]
    const id = finding.id!
    if (finding.prior_id && input.dismissedPriorIds?.has(finding.prior_id)) {
      suppressed.push({ id, reason: 'dismissed' })
      continue
    }
    if ((finding.disposition ?? 'standing') === 'refuted') {
      suppressed.push({
        id,
        reason: 'refuted',
        ...(finding.ruling_reason ? { ruling: finding.ruling_reason } : {})
      })
      continue
    }

    const gradedResult = applyEvidenceGate(finding, {
      fromPrepass,
      resolves: input.resolvesEvidence
    })
    if (!gradedResult.finding) {
      suppressed.push({ id, reason: gradedResult.reason ?? 'falsified' })
      continue
    }
    const graded = gradedResult.finding
    if ((graded.disposition ?? 'standing') === 'contested') {
      if (input.depth === 'deep') {
        contested.push(graded)
      } else {
        suppressed.push({ id, reason: 'refuted' })
      }
      continue
    }
    if ((graded.kind ?? 'finding') === 'limitation') {
      limitations.push(graded)
      continue
    }
    if ((graded.kind ?? 'finding') === 'question') {
      questions.push(graded)
      continue
    }
    const completed = {
      ...graded,
      effective_severity: effectiveSeverity(graded),
      blocking: isBlocking(graded)
    }
    survivors.push(completed)
  }

  survivors.sort(compareFindings)
  limitations.sort(compareFindings)
  questions.sort(compareFindings)
  contested.sort(compareFindings)
  const verdict = computeVerdict({
    reviewerResolved: input.reviewerResolved,
    artifactCaptured: input.artifactCaptured,
    prepassStatus: input.prepassStatus,
    profile: input.profile,
    findings: survivors,
    contested
  })
  const severityHistogram: Partial<Record<FindingSeverity, number>> = {}
  for (const finding of survivors) {
    const severity = effectiveSeverity(finding)
    severityHistogram[severity] = (severityHistogram[severity] ?? 0) + 1
  }
  const blockingCount = survivors.filter(isBlocking).length
  return GateResultSchema.parse({
    ...(verdict === null ? {} : { verdict }),
    findings: survivors,
    limitations,
    questions,
    contested,
    suppressed,
    suppressed_count: suppressed.length,
    depth: input.depth,
    severity_histogram: severityHistogram,
    blocking_count: blockingCount,
    advisory_count: survivors.length - blockingCount,
    contested_count: contested.length,
    unreviewed_paths: [...(input.unreviewedPaths ?? [])],
    regrade_count: survivors.filter((finding) => finding.adjudicated_severity !== undefined).length,
    chain: input.chain
  })
}

export const gateFindings = evaluateEvidenceGate
