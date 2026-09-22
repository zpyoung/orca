import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { createTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import { localFleetEntry } from './local-fleet-projection'

function objectiveEntry(): WatcherListEntry {
  return {
    name: 'Ship the objective',
    enrollment: {
      watcherId: 'watcher-objective',
      kind: 'objective',
      workspaceKey: 'local::/workspace/objective',
      executionHostId: 'local',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      workspacePath: '/workspace/objective',
      schedulerOwner: 'local_host_service',
      enabled: true,
      paused: false,
      commandRevision: 1,
      capabilities: { plan: 'on' },
      budget: { wallClockActiveMs: 60_000, turns: 4 },
      kindPayload: { workspaceKind: 'git' },
      coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
      orchestrationRunId: 'run-1',
      createdAtMs: 10,
      terminalAtMs: null
    },
    status: {
      watcherId: 'watcher-objective',
      enabled: true,
      state: 'watching',
      phase: 'watching',
      reason: null,
      parkReason: null,
      budget: { activeMs: 2_000, turns: 1, exhausted: null },
      startedAtMs: 10,
      lastSuccessfulTickAtMs: 80,
      nextPulseAtMs: 100
    }
  }
}

describe('local Heimdall fleet projection', () => {
  it('projects authoritative objective phase separately from runner state while agent work is outstanding', () => {
    const trace = createTickTrace(3, 70, {
      consecutiveErrors: 0,
      lastFullResyncAtMs: 70,
      reconcileAgain: false
    })
    trace.snapshot = { phase: 'planning', branch: 'feature/objective' }
    trace.durationMs = 5
    trace.exitPath = 'acted'
    const ledger: WatcherLedger = {
      watcherId: 'watcher-objective',
      entries: [
        {
          eventId: 'attempt-running',
          watcherId: 'watcher-objective',
          atMs: 75,
          origin: 'owner',
          class: 'fact',
          kind: 'attempt',
          attemptId: 'attempt-1',
          fingerprint: 'fingerprint-1',
          action: {
            kind: 'dispatch-planner',
            capability: 'plan',
            visibility: 'local',
            contentIdentity: 'content-1',
            evidenceKey: 'planner-1'
          },
          state: 'running',
          dispatch: {
            spec: 'Produce the implementation plan.',
            taskKey: 'planning',
            dispatchKind: 'planner'
          },
          dispatchId: 'dispatch-1'
        }
      ]
    }

    expect(
      localFleetEntry(objectiveEntry(), 90, true, {
        ledger,
        traces: [trace],
        workspaceLabel: 'Objective worktree',
        parallel: {
          runningCount: 2,
          effectiveMaxConcurrency: 3,
          note: 'One lane is waiting to apply.'
        }
      })
    ).toMatchObject({
      workflowPhase: 'planning',
      activity: {
        kind: 'agent-in-flight',
        count: 1,
        detail: 'planning',
        startedAtMs: 75
      },
      parallel: {
        runningCount: 2,
        effectiveMaxConcurrency: 3,

        note: 'One lane is waiting to apply.'
      },
      workspace: {
        label: 'Objective worktree',
        kind: 'git',
        branch: 'feature/objective'
      },
      entry: { status: { phase: 'watching' } }
    })
  })
  it('projects a newly persisted cap before a paused runner refreshes its snapshot', () => {
    const entry = objectiveEntry()
    entry.enrollment.kindPayload = { workspaceKind: 'git', maxConcurrency: 1 }

    const projected = localFleetEntry(entry, 90, true, {
      ledger: { watcherId: 'watcher-objective', entries: [] },
      traces: [],
      workspaceLabel: 'Objective worktree',
      parallel: { runningCount: 2, effectiveMaxConcurrency: 3 }
    })

    expect(projected.parallel).toEqual({ runningCount: 2, effectiveMaxConcurrency: 1 })
  })
})
