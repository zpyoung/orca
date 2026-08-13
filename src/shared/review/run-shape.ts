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

type PredecessorTable = Partial<Record<ChainStep, readonly ChainStep[]>>

// Shared by every depth: `resolve` mints the run id and has no predecessor;
// `prepass`/`select-model` both fan out from it directly.
const COMMON_PREFIX: PredecessorTable = {
  resolve: [],
  prepass: ['resolve'],
  'select-model': ['resolve']
}

/**
 * Accepted-predecessor sets per depth, keyed by `chain.step`. An empty array
 * means "no predecessor" (only `resolve`); a step absent from a depth's
 * table is not part of that depth's shape at all — a run cannot skip into
 * it or out of it. `deep`'s `merge` accepts both `claims` (the first,
 * refute-stage round) and `merge` (a tiebreak round chained directly off the
 * refute round's own output, never off `gate` — upstream `CHAIN_PREDECESSOR`).
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
    merge: ['claims'],
    gate: ['merge'],
    manifest: ['gate']
  },
  deep: {
    ...COMMON_PREFIX,
    claims: ['resolve'],
    merge: ['claims', 'merge'],
    gate: ['merge'],
    'gate.final': ['merge'],
    manifest: ['gate', 'gate.final']
  }
}

export function acceptsPredecessor(
  depth: ReviewDepth,
  step: ChainStep,
  predecessorStep: ChainStep | null
): boolean {
  const accepted = RUN_SHAPE_TABLE[depth][step]
  if (!accepted) {
    return false
  }
  if (accepted.length === 0) {
    return predecessorStep === null
  }
  return predecessorStep !== null && accepted.includes(predecessorStep)
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
