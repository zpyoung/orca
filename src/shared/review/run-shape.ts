export const REVIEW_DEPTHS = ['quick', 'standard', 'deep'] as const
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number]

export const REVIEW_CHAIN_STEPS = [
  'resolve',
  'prepass',
  'select-model',
  'claims',
  'merge',
  'gate',
  'gate.final',
  'manifest'
] as const
export type ChainStep = (typeof REVIEW_CHAIN_STEPS)[number]

export const MERGE_STAGES = ['refute', 'tiebreak'] as const
export type MergeStage = (typeof MERGE_STAGES)[number]

// `merge` is one `chain.step` name shared by two structurally different
// rounds (refute, tiebreak); a bare step name can't tell a refute round's
// output from a tiebreak round's, so both table keys and predecessor refs
// for `merge` carry its stage alongside the step name.
type StepRef = Exclude<ChainStep, 'merge'> | `merge:${MergeStage}`

type PredecessorTable = Partial<Record<StepRef, readonly StepRef[]>>

/** The `step`/`predecessor` stage to check, only meaningful when that side is `merge`. */
export type MergeStageQualifiers = {
  step?: MergeStage
  predecessor?: MergeStage
}

// Shared by every depth: `resolve` mints the run id and has no predecessor;
// `prepass`/`select-model` both fan out from it directly.
const COMMON_PREFIX: PredecessorTable = {
  resolve: [],
  prepass: ['resolve'],
  'select-model': ['resolve']
}

/**
 * Accepted-predecessor sets per depth, keyed by `chain.step` (merge steps
 * qualified by stage). An empty array means "no predecessor" (only
 * `resolve`); a key absent from a depth's table is not part of that depth's
 * shape at all — a run cannot skip into it or out of it.
 *
 * `deep`'s `merge:refute` accepts only `claims` (the recall round); its
 * `merge:tiebreak` accepts only `merge:refute` (chained directly off the
 * refute round's own output, never off `gate` — upstream `CHAIN_PREDECESSOR`),
 * so a third round or a same-stage repeat has no accepting entry. `gate`
 * accepts only `merge:refute`; `gate.final` accepts only `merge:tiebreak` —
 * each is the single-round output it was designed for, not the other's.
 * `deep`'s `manifest` accepts a plain `gate` (nothing was contested) or
 * `gate.final` (a tiebreak round settled a dispute); `manifestAcceptsGate`
 * below adds the payload-level refusal step identity alone cannot express.
 */
export const RUN_SHAPE_TABLE: Record<ReviewDepth, PredecessorTable> = {
  quick: {
    ...COMMON_PREFIX,
    gate: ['select-model'],
    manifest: ['gate']
  },
  standard: {
    ...COMMON_PREFIX,
    claims: ['resolve'],
    'merge:refute': ['claims'],
    gate: ['merge:refute'],
    manifest: ['gate']
  },
  deep: {
    ...COMMON_PREFIX,
    claims: ['resolve'],
    'merge:refute': ['claims'],
    'merge:tiebreak': ['merge:refute'],
    gate: ['merge:refute'],
    'gate.final': ['merge:tiebreak'],
    manifest: ['gate', 'gate.final']
  }
}

function stepRef(step: ChainStep, stage: MergeStage | undefined): StepRef | null {
  if (step !== 'merge') {
    return step
  }
  // a merge step with no declared stage can't be looked up — which round it
  // is is exactly the fact the table keys on.
  return stage ? `merge:${stage}` : null
}

export function acceptsPredecessor(
  depth: ReviewDepth,
  step: ChainStep,
  predecessorStep: ChainStep | null,
  mergeStages?: MergeStageQualifiers
): boolean {
  const key = stepRef(step, mergeStages?.step)
  if (key === null) {
    return false
  }
  const accepted = RUN_SHAPE_TABLE[depth][key]
  if (!accepted) {
    return false
  }
  if (accepted.length === 0) {
    return predecessorStep === null
  }
  if (predecessorStep === null) {
    return false
  }
  const predecessorRef = stepRef(predecessorStep, mergeStages?.predecessor)
  return predecessorRef !== null && accepted.includes(predecessorRef)
}

/**
 * `manifest` refuses any gate payload whose `contested[]` is non-empty
 * (upstream `build_manifest`), regardless of depth or which of `gate` /
 * `gate.final` produced it — a rule step identity alone cannot express,
 * since an empty- and non-empty-contested `gate` share one step name.
 */
export function manifestAcceptsGate(
  depth: ReviewDepth,
  gateStep: ChainStep,
  contestedCount: number
): boolean {
  return acceptsPredecessor(depth, 'manifest', gateStep) && contestedCount === 0
}
