import type { StateCreator } from 'zustand'
import {
  decodePipelineRunState,
  type PipelineRunSnapshotWire,
  type PipelineRunState
} from '../../../../shared/pipeline-run-snapshot'

const HYDRATION_DEADLINE_MS = 30_000

export type PipelineRunSummary = {
  runId: string
  templateName: string
  runNumber: number
  state: PipelineRunState | 'unknown'
  workspaceId: string | null
  lastSnapshotAt: number | null
}

export type PipelineRunHydrationPhase =
  | { phase: 'in-flight'; startedAt: number; generation: number }
  | { phase: 'hydrated' }
  | { phase: 'failed' }

// mirrors the host's pipeline.listRuns wire shape; renderer and main are separate
// typecheck projects, so that shape can't be imported directly.
export type PipelineRunListEntry = {
  runId: string
  templateName: string
  runNumber: number
  state: string
  workspaceId?: string
}

export type PipelineRunsSlice = {
  pipelineRunsById: Record<string, PipelineRunSummary>
  pipelineRunHydrationByWorkspaceId: Record<string, PipelineRunHydrationPhase>
  requestPipelineRunHydration: (worktreeId: string) => number
  hydratePipelineRuns: (
    worktreeId: string,
    generation: number,
    entries: PipelineRunListEntry[]
  ) => void
  markPipelineRunHydrationFailed: (worktreeId: string, generation: number) => void
  upsertPipelineRunFromSnapshot: (snapshot: PipelineRunSnapshotWire) => void
}

export const createPipelineRunsSlice: StateCreator<PipelineRunsSlice, [], [], PipelineRunsSlice> = (
  set,
  get
) => {
  // per-workspace monotonic counters live outside the exposed hydration phase (which
  // drops its generation once it leaves 'in-flight') so a demote-and-refire can never
  // hand a retry the same number a still-pending original request might later complete with.
  const nextGenerationByWorktreeId = new Map<string, number>()

  const bumpGeneration = (worktreeId: string): number => {
    const generation = (nextGenerationByWorktreeId.get(worktreeId) ?? 0) + 1
    nextGenerationByWorktreeId.set(worktreeId, generation)
    return generation
  }

  return {
    pipelineRunsById: {},
    pipelineRunHydrationByWorkspaceId: {},

    requestPipelineRunHydration: (worktreeId) => {
      const existing = get().pipelineRunHydrationByWorkspaceId[worktreeId]
      const isFreshInFlight =
        existing?.phase === 'in-flight' && Date.now() - existing.startedAt < HYDRATION_DEADLINE_MS
      if (isFreshInFlight) {
        return existing.generation
      }
      const generation = bumpGeneration(worktreeId)
      set((s) => ({
        pipelineRunHydrationByWorkspaceId: {
          ...s.pipelineRunHydrationByWorkspaceId,
          [worktreeId]: { phase: 'in-flight', startedAt: Date.now(), generation }
        }
      }))
      return generation
    },

    hydratePipelineRuns: (worktreeId, generation, entries) => {
      const current = get().pipelineRunHydrationByWorkspaceId[worktreeId]
      // a completion whose generation isn't the current in-flight one is stale evidence:
      // it must not touch the run map or the phase, success or failure alike.
      if (current?.phase !== 'in-flight' || current.generation !== generation) {
        return
      }
      set((s) => {
        const nextRunsById = { ...s.pipelineRunsById }
        for (const entry of entries) {
          const priorRun = nextRunsById[entry.runId]
          nextRunsById[entry.runId] = {
            runId: entry.runId,
            templateName: entry.templateName,
            runNumber: entry.runNumber,
            state: decodePipelineRunState(entry.state),
            workspaceId: entry.workspaceId ?? null,
            lastSnapshotAt: priorRun?.lastSnapshotAt ?? null
          }
        }
        return {
          pipelineRunsById: nextRunsById,
          pipelineRunHydrationByWorkspaceId: {
            ...s.pipelineRunHydrationByWorkspaceId,
            [worktreeId]: { phase: 'hydrated' }
          }
        }
      })
    },

    markPipelineRunHydrationFailed: (worktreeId, generation) => {
      const current = get().pipelineRunHydrationByWorkspaceId[worktreeId]
      if (current?.phase !== 'in-flight' || current.generation !== generation) {
        return
      }
      set((s) => ({
        pipelineRunHydrationByWorkspaceId: {
          ...s.pipelineRunHydrationByWorkspaceId,
          [worktreeId]: { phase: 'failed' }
        }
      }))
    },

    upsertPipelineRunFromSnapshot: (snapshot) => {
      set((s) => {
        const priorRun = s.pipelineRunsById[snapshot.runId]
        return {
          pipelineRunsById: {
            ...s.pipelineRunsById,
            [snapshot.runId]: {
              runId: snapshot.runId,
              templateName: snapshot.templateName ?? priorRun?.templateName ?? '',
              runNumber: snapshot.runNumber ?? priorRun?.runNumber ?? 0,
              state:
                snapshot.state !== undefined
                  ? decodePipelineRunState(snapshot.state)
                  : (priorRun?.state ?? 'unknown'),
              // the snapshot wire never carries workspaceId; only listRuns hydration does.
              workspaceId: priorRun?.workspaceId ?? null,
              lastSnapshotAt: Date.now()
            }
          }
        }
      })
    }
  }
}
