import type { ReviewRunState, RunRecord } from './stage-schemas'

export const MAX_REVIEW_RUNS_PER_WORKSPACE = 20
export const TERMINAL_REVIEW_RUN_STATES = [
  'completed',
  'failed',
  'aborted',
  'interrupted'
] as const satisfies readonly ReviewRunState[]

const terminalStates = new Set<ReviewRunState>(TERMINAL_REVIEW_RUN_STATES)

export function isTerminalReviewRunState(state: ReviewRunState): boolean {
  return terminalStates.has(state)
}

export type ReviewRetentionEntry = Pick<
  RunRecord,
  'run_id' | 'state' | 'created_at' | 'campaign_hash'
>

export type ReviewRunRetentionPlan<T extends ReviewRetentionEntry> = {
  kept: T[]
  evicted: T[]
  orphanedCampaignHashes: string[]
}

/** Keeps active runs unconditionally, then fills the workspace cap with newest terminal runs. */
export function planReviewRunRetention<T extends ReviewRetentionEntry>(
  runs: readonly T[],
  maxRuns: number = MAX_REVIEW_RUNS_PER_WORKSPACE,
  knownCampaignHashes: readonly string[] = []
): ReviewRunRetentionPlan<T> {
  const activeCount = runs.filter((run) => !isTerminalReviewRunState(run.state)).length
  const terminalCapacity = Math.max(0, maxRuns - activeCount)
  const terminalToKeep = new Set(
    runs
      .filter((run) => isTerminalReviewRunState(run.state))
      .map((run, index) => ({ run, index }))
      .sort(
        (left, right) =>
          right.run.created_at.localeCompare(left.run.created_at) ||
          right.run.run_id.localeCompare(left.run.run_id) ||
          right.index - left.index
      )
      .slice(0, terminalCapacity)
      .map(({ run }) => run.run_id)
  )
  const kept = runs.filter(
    (run) => !isTerminalReviewRunState(run.state) || terminalToKeep.has(run.run_id)
  )
  const evicted = runs.filter(
    (run) => isTerminalReviewRunState(run.state) && !terminalToKeep.has(run.run_id)
  )
  const survivingCampaigns = new Set(
    kept.flatMap((run) => (run.campaign_hash ? [run.campaign_hash] : []))
  )
  const candidates = new Set([
    ...knownCampaignHashes,
    ...evicted.flatMap((run) => (run.campaign_hash ? [run.campaign_hash] : []))
  ])
  const orphanedCampaignHashes = [...candidates]
    .filter((hash) => !survivingCampaigns.has(hash))
    .sort()
  return { kept, evicted, orphanedCampaignHashes }
}

export function pruneReviewRuns<T extends ReviewRetentionEntry>(
  runs: readonly T[],
  maxRuns: number = MAX_REVIEW_RUNS_PER_WORKSPACE
): T[] {
  return planReviewRunRetention(runs, maxRuns).kept
}
