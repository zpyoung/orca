import { describe, expect, it } from 'vitest'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import {
  resolveFleetActivity,
  resolveFleetWorkflowPhase,
  resolveFleetWorkspace
} from './fleet-row-presentation'

function fleetRow(): WatcherFleetEntry {
  return {
    target: { watcherId: 'watcher-1', connectionId: 'runtime-1', pairingRevision: 4 },
    entry: {
      name: 'Ship the objective',
      enrollment: {
        watcherId: 'watcher-1',
        kind: 'objective',
        workspaceKey: 'runtime:runtime-1::/srv/repo',
        executionHostId: 'runtime:runtime-1',
        repoId: 'repo-1',
        worktreeId: null,
        workspacePath: '/srv/repo',
        schedulerOwner: 'remote_host_service',
        enabled: true,
        paused: false,
        commandRevision: 1,
        capabilities: { plan: 'on' },
        budget: { wallClockActiveMs: null, turns: null },
        kindPayload: { workspaceKind: 'git' },
        coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
        orchestrationRunId: null,
        createdAtMs: 1,
        terminalAtMs: null
      },
      status: {
        watcherId: 'watcher-1',
        enabled: true,
        state: 'watching',
        phase: 'watching',
        reason: null,
        parkReason: null,
        budget: { activeMs: 0, turns: 0, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: 20,
        nextPulseAtMs: 30
      }
    },
    ownerFence: {
      executionHostId: 'runtime:runtime-1',
      schedulerOwner: 'remote_host_service',
      workspaceKey: 'runtime:runtime-1::/srv/repo',
      revision: 1
    },
    observedAtMs: 20,
    contact: 'unverifiable',
    readOnlyReason: 'The owning runtime cannot be reached.',
    capabilityNotes: [],
    paused: false,
    workflowPhase: 'planning',
    activity: { kind: 'waiting', count: 0, detail: null, startedAtMs: null },
    workspace: { label: 'Readable repo', kind: 'git', branch: 'feature/fleet' }
  }
}

describe('Heimdall fleet row presentation', () => {
  it('lets lost contact override stale owner activity and treats omitted old-host metadata as unknown', () => {
    const disconnected = fleetRow()
    expect(resolveFleetActivity(disconnected)).toEqual({
      kind: 'unverifiable',
      lastConfirmedAtMs: 20
    })

    const oldHost = fleetRow()
    oldHost.contact = 'live'
    delete oldHost.activity
    delete oldHost.workflowPhase
    delete oldHost.workspace

    expect(resolveFleetActivity(oldHost)).toEqual({ kind: 'unknown' })
    expect(resolveFleetWorkflowPhase(oldHost)).toBeNull()
    expect(resolveFleetWorkspace(oldHost)).toMatchObject({
      label: 'repo',
      kind: 'git',
      branch: null
    })
  })
})
