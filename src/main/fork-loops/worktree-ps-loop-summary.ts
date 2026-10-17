import type {
  LoopSnapshot,
  LoopState,
  LoopWorktreeSummary
} from '../../shared/fork-loops/loop-types'
import { LoopStoreError } from './loop-database'
import type { LoopService } from './loop-service'

const LIVE_STATES: ReadonlySet<LoopState> = new Set(['running', 'needs-you'])

/**
 * Projects a worktree's loops onto the `worktree ps` field. `snapshots` must be ordered most
 * recently updated first (as `LoopService.list` returns them); the primary loop is the first live
 * one, otherwise the first of all. Returns undefined when the worktree has no loops.
 */
export function summarizeWorktreeLoops(
  snapshots: readonly LoopSnapshot[],
  worktreeId: string
): LoopWorktreeSummary | undefined {
  const loops = snapshots.filter((snapshot) => snapshot.worktreeId === worktreeId)
  const primary = loops.find((loop) => LIVE_STATES.has(loop.state)) ?? loops[0]
  if (!primary) {
    return undefined
  }
  const maxIterations = primary.config.caps.maxIterations
  return {
    loopCount: loops.length,
    primary: {
      id: primary.id,
      name: primary.name,
      state: primary.state,
      ...(primary.pauseReason ? { pauseReason: primary.pauseReason } : {}),
      iterationsCompleted: primary.iterationsCompleted,
      ...(maxIterations === undefined ? {} : { maxIterations })
    }
  }
}

/**
 * Sets `loop` on each `worktree ps` summary that has loops. A runtime without a loop service
 * (test doubles) or a failing loop store leaves every row untouched: loops never fail the listing.
 */
export function attachWorktreeLoopSummaries(
  summaries: Map<string, { worktreeId: string; loop?: LoopWorktreeSummary }>,
  getService: () => Pick<LoopService, 'list'>
): void {
  let snapshots: LoopSnapshot[]
  try {
    snapshots = getService().list()
  } catch (error) {
    if (!(error instanceof LoopStoreError && error.code === 'loop_runtime_unavailable')) {
      console.warn('[loops] worktree ps summary skipped:', error)
    }
    return
  }
  for (const summary of summaries.values()) {
    const loop = summarizeWorktreeLoops(snapshots, summary.worktreeId)
    if (loop) {
      summary.loop = loop
    }
  }
}
