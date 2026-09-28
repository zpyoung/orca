import { WatcherFleetEntrySchema, type WatcherFleetEntry } from './fleet-types'

export function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>()
}

export function buildWatcherFleetEntry(
  revision: number,
  observedAtMs = revision,
  watcherId = 'watcher-1'
): WatcherFleetEntry {
  return WatcherFleetEntrySchema.parse({
    target: { watcherId, connectionId: 'hermes', pairingRevision: 7 },
    ownerFence: {
      executionHostId: 'runtime:hermes',
      schedulerOwner: 'remote_host_service',
      workspaceKey: 'runtime:hermes::worktree-1',
      revision
    },
    observedAtMs,
    contact: 'live',
    readOnlyReason: null,
    capabilityNotes: [],
    paused: false,
    entry: {
      name: `Objective ${watcherId}`,
      enrollment: {
        watcherId,
        kind: 'objective',
        workspaceKey: 'runtime:hermes::worktree-1',
        executionHostId: 'runtime:hermes',
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        workspacePath: '/workspace/repo-1',
        schedulerOwner: 'remote_host_service',
        enabled: true,
        paused: false,
        commandRevision: revision,
        capabilities: {
          plan: 'gated',
          implement: 'on',
          review: 'on',
          check: 'on',
          land: 'on'
        },
        budget: { wallClockActiveMs: 14_400_000, turns: 40 },
        kindPayload: {},
        coordinatorIdentity: { handle: 'main', paneKey: 'pane-1' },
        orchestrationRunId: null,
        createdAtMs: 1,
        terminalAtMs: null
      },
      status: {
        watcherId,
        enabled: true,
        state: 'watching',
        phase: 'observe',
        reason: null,
        parkReason: null,
        budget: { activeMs: 0, turns: 0, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: null,
        nextPulseAtMs: null
      }
    }
  })
}
