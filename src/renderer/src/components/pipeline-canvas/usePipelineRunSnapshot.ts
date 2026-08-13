import { useEffect, useMemo, useState } from 'react'
import {
  decodePipelineRunState,
  type PipelineRunSnapshotWire,
  type PipelineRunState
} from '../../../../shared/pipeline-run-snapshot'
import {
  subscribeToPipelineRunSnapshot,
  type PipelineRunSubscriptionError
} from '@/runtime/pipeline-run-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'

const STALENESS_THRESHOLD_MS = 15_000

const TERMINAL_RUN_STATES: ReadonlySet<PipelineRunState> = new Set([
  'completed',
  'failed',
  'aborted',
  'interrupted'
])

export type PipelineRunSnapshotState = {
  snapshot: PipelineRunSnapshotWire | null
  runState: PipelineRunState | 'unknown' | null
  isStale: boolean
  subscriptionError: PipelineRunSubscriptionError | null
  target: RuntimeClientTarget
}

/**
 * Live client for one pipeline run's `pipeline.subscribe` stream: decodes the
 * run state (unknown tags never throw), feeds every snapshot into the
 * pipeline-runs store slice, and derives the staleness indicator from the
 * newest snapshot's `publishedAt` rather than from message-arrival timing.
 *
 * Resolves its host from the run's own owning workspace (via the pipeline-runs
 * store slice), not the globally selected runtime environment — a run must stay
 * reachable, and its controls must stay targeted at the right host, regardless
 * of what the user has selected elsewhere in the app.
 */
export function usePipelineRunSnapshot(runId: string): PipelineRunSnapshotState {
  const runEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, state.pipelineRunsById[runId]?.workspaceId ?? null)
  )
  const target: RuntimeClientTarget = useMemo(
    () =>
      runEnvironmentId ? { kind: 'environment', environmentId: runEnvironmentId } : { kind: 'local' },
    [runEnvironmentId]
  )
  const upsertPipelineRunFromSnapshot = useAppStore((state) => state.upsertPipelineRunFromSnapshot)
  const [snapshot, setSnapshot] = useState<PipelineRunSnapshotWire | null>(null)
  const [isStale, setIsStale] = useState(false)
  const [subscriptionError, setSubscriptionError] = useState<PipelineRunSubscriptionError | null>(
    null
  )

  useEffect(() => {
    let disposed = false
    setSnapshot(null)
    setIsStale(false)
    setSubscriptionError(null)

    let subscription: { unsubscribe: () => void } | null = null

    void subscribeToPipelineRunSnapshot(
      target,
      runId,
      (next) => {
        if (disposed) {
          return
        }
        setSnapshot(next)
        setIsStale(false)
        setSubscriptionError(null)
        upsertPipelineRunFromSnapshot(next)
      },
      (error) => {
        if (disposed) {
          return
        }
        console.warn('[usePipelineRunSnapshot] subscription error:', error)
        setSubscriptionError(error)
      }
    ).then((handle) => {
      if (disposed) {
        handle.unsubscribe()
        return
      }
      subscription = handle
    })

    return () => {
      disposed = true
      subscription?.unsubscribe()
    }
  }, [runId, target, upsertPipelineRunFromSnapshot])

  useEffect(() => {
    if (!snapshot) {
      return
    }
    const runState = decodePipelineRunState(snapshot.state)
    if (runState !== 'unknown' && TERMINAL_RUN_STATES.has(runState)) {
      return
    }
    const publishedAtMs = snapshot.publishedAt ? Date.parse(snapshot.publishedAt) : Number.NaN
    const referenceMs = Number.isFinite(publishedAtMs) ? publishedAtMs : Date.now()
    const remainingMs = STALENESS_THRESHOLD_MS - (Date.now() - referenceMs)
    if (remainingMs <= 0) {
      setIsStale(true)
      return
    }
    const timeoutId = window.setTimeout(() => setIsStale(true), remainingMs)
    return () => window.clearTimeout(timeoutId)
  }, [snapshot])

  return {
    snapshot,
    runState: snapshot ? decodePipelineRunState(snapshot.state) : null,
    isStale,
    subscriptionError,
    target
  }
}
