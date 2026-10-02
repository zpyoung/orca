import { describe, expect, it } from 'vitest'
import type { RpcContext } from '../../core'
import { NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../shared/protocol-version'
import type {
  HeimdallFleetSnapshot,
  WatcherDetail,
  WatcherFleetEntry
} from '../../../../../shared/fork-heimdall/fleet-types'
import type {
  WatcherKindId,
  WatcherListEntry
} from '../../../../../shared/fork-heimdall/watcher-types'
import {
  projectHeimdallDetailParkReasonForClient,
  projectHeimdallFleetSnapshotForClient
} from './park-reason-wire'
import { clientReadsPipelineKind, projectPipelineListForClient } from './pipeline-kind-wire'
type WireContext = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

const LEGACY_CONTEXT: WireContext = { clientKind: 'runtime', clientCapabilities: [] }
const NATIVE_CONTEXT: WireContext = {
  clientKind: undefined,
  clientCapabilities: [...NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES]
}
const IN_PROCESS_CONTEXT: WireContext = { clientKind: undefined, clientCapabilities: [] }

function watcherEntry(kind: WatcherKindId): WatcherListEntry {
  return {
    name: `${kind} watcher`,
    enrollment: {
      watcherId: `${kind}-watcher`,
      kind,
      workspaceKey: 'local::/repo',
      executionHostId: 'local',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      workspacePath: '/repo',
      schedulerOwner: 'local_host_service',
      enabled: true,
      paused: false,
      commandRevision: 1,
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: {},
      coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
      orchestrationRunId: null,
      createdAtMs: 1,
      terminalAtMs: null
    },
    status: {
      watcherId: `${kind}-watcher`,
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
}

function fleetEntry(kind: WatcherKindId): WatcherFleetEntry {
  const entry = watcherEntry(kind)
  return {
    target: { watcherId: entry.enrollment.watcherId, connectionId: null, pairingRevision: null },
    entry,
    ownerFence: {
      executionHostId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceKey: 'local::/repo',
      revision: 1
    },
    observedAtMs: 1,
    contact: 'live',
    readOnlyReason: null,
    capabilityNotes: [],
    paused: false
  }
}

function snapshot(): HeimdallFleetSnapshot {
  return { entries: [fleetEntry('objective'), fleetEntry('pipeline')], generatedAtMs: 1 }
}

function detail(kind: WatcherKindId): WatcherDetail {
  return {
    watcher: fleetEntry(kind),
    ledger: { watcherId: `${kind}-watcher`, entries: [] },
    traces: [],
    workers: []
  }
}

describe('pipeline kind wire compatibility', () => {
  it('hides pipeline rows from old clients and retains them for native and in-process clients', () => {
    const source = snapshot()
    const legacy = projectHeimdallFleetSnapshotForClient(source, LEGACY_CONTEXT)
    const native = projectHeimdallFleetSnapshotForClient(source, NATIVE_CONTEXT)
    const inProcess = projectHeimdallFleetSnapshotForClient(source, IN_PROCESS_CONTEXT)

    expect(legacy.entries.map((entry) => entry.entry.enrollment.kind)).toEqual(['objective'])
    expect(native.entries.map((entry) => entry.entry.enrollment.kind)).toEqual([
      'objective',
      'pipeline'
    ])
    expect(inProcess).toBe(source)
    expect(clientReadsPipelineKind(IN_PROCESS_CONTEXT)).toBe(true)
  })
  it('filters pipeline rows from legacy lists without changing native lists', () => {
    const entries = [watcherEntry('objective'), watcherEntry('pipeline')]

    expect(projectPipelineListForClient(entries, LEGACY_CONTEXT)).toEqual([entries[0]])
    expect(projectPipelineListForClient(entries, NATIVE_CONTEXT)).toBe(entries)
  })

  it('reports a pipeline detail as missing to a client that cannot decode its kind', () => {
    expect(() =>
      projectHeimdallDetailParkReasonForClient(detail('pipeline'), LEGACY_CONTEXT)
    ).toThrow('watcher-not-found')
    expect(
      projectHeimdallDetailParkReasonForClient(detail('objective'), LEGACY_CONTEXT).watcher.entry
        .enrollment.kind
    ).toBe('objective')
  })
})
