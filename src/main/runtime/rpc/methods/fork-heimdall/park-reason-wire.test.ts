import { describe, expect, it } from 'vitest'
import {
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
} from '../../../../../shared/fork-heimdall/capability'
import type {
  HeimdallFleetSnapshot,
  WatcherDetail
} from '../../../../../shared/fork-heimdall/fleet-types'
import type { ObjectiveDetail } from '../../../../../shared/fork-heimdall-objective/detail-types'
import {
  WatcherParkReasonSchema,
  type WatcherListEntry,
  type WatcherParkReason
} from '../../../../../shared/fork-heimdall/watcher-types'
import type { RpcContext } from '../../core'
import {
  projectHeimdallDetailParkReasonForClient,
  projectHeimdallFleetSnapshotForClient,
  projectObjectiveDetailParallelForClient,
  projectWatcherListEntryForClient
} from './park-reason-wire'

const LOCAL_CONTEXT: Pick<RpcContext, 'clientKind' | 'clientCapabilities'> = {}
const LEGACY_CONTEXT: Pick<RpcContext, 'clientKind' | 'clientCapabilities'> = {
  clientKind: 'runtime',
  clientCapabilities: []
}
const CAPABLE_CONTEXT: Pick<RpcContext, 'clientKind' | 'clientCapabilities'> = {
  clientKind: 'runtime',
  clientCapabilities: [HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY]
}
const PARALLEL_CONTEXT: Pick<RpcContext, 'clientKind' | 'clientCapabilities'> = {
  clientKind: 'runtime',
  clientCapabilities: [HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY]
}

function listEntry(parkReason: WatcherParkReason | null): WatcherListEntry {
  return {
    name: 'Watcher one',
    enrollment: {
      watcherId: 'watcher-1',
      kind: 'objective',
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
      watcherId: 'watcher-1',
      enabled: true,
      state: 'parked',
      phase: 'observe',
      reason: null,
      parkReason,
      budget: { activeMs: 0, turns: 0, exhausted: null },
      startedAtMs: 1,
      lastSuccessfulTickAtMs: null,
      nextPulseAtMs: null
    }
  }
}

function fleetEntry(parkReason: WatcherParkReason | null): WatcherDetail['watcher'] {
  return {
    target: { watcherId: 'watcher-1', connectionId: null, pairingRevision: null },
    entry: listEntry(parkReason),
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

function detail(parkReason: WatcherParkReason | null): WatcherDetail {
  return {
    watcher: fleetEntry(parkReason),
    ledger: { watcherId: 'watcher-1', entries: [] },
    traces: [],
    workers: []
  }
}

function snapshot(parkReason: WatcherParkReason | null): HeimdallFleetSnapshot {
  return { entries: [fleetEntry(parkReason)], generatedAtMs: 1 }
}

const WORKER_ESCALATION: WatcherParkReason = {
  kind: 'worker-escalation',
  escalationId: 'escalation-1',
  messageId: 'message-1'
}
const CONFIGURATION_ERROR: WatcherParkReason = { kind: 'configuration-error', reason: 'bad config' }
const STOP_PREDICATE: WatcherParkReason = {
  kind: 'stop-predicate',
  predicateId: 'predicate-1',
  reason: 'stopped'
}

describe('projectWatcherListEntryForClient', () => {
  it.each([WORKER_ESCALATION, CONFIGURATION_ERROR])(
    'degrades a %s park reason for a reader without the capability',
    (parkReason) => {
      const projected = projectWatcherListEntryForClient(listEntry(parkReason), LEGACY_CONTEXT)
      expect(projected.status.parkReason).toBeNull()
    }
  )

  it('leaves an older park reason kind untouched', () => {
    const entry = listEntry(STOP_PREDICATE)
    expect(projectWatcherListEntryForClient(entry, LEGACY_CONTEXT)).toBe(entry)
  })

  it('leaves a null park reason untouched', () => {
    const entry = listEntry(null)
    expect(projectWatcherListEntryForClient(entry, LEGACY_CONTEXT)).toBe(entry)
  })

  it('publishes the typed value once the capability is negotiated', () => {
    const projected = projectWatcherListEntryForClient(
      listEntry(WORKER_ESCALATION),
      CAPABLE_CONTEXT
    )
    expect(projected.status.parkReason).toEqual(WORKER_ESCALATION)
  })

  it('never degrades an in-process read', () => {
    const entry = listEntry(WORKER_ESCALATION)
    expect(projectWatcherListEntryForClient(entry, LOCAL_CONTEXT)).toBe(entry)
  })
})

describe('projectHeimdallFleetSnapshotForClient', () => {
  it('degrades every entry a legacy reader would fail to parse', () => {
    const projected = projectHeimdallFleetSnapshotForClient(
      snapshot(WORKER_ESCALATION),
      LEGACY_CONTEXT
    )
    expect(projected.entries[0]?.entry.status.parkReason).toBeNull()
  })

  it('returns the same snapshot reference when nothing needs degrading', () => {
    const source = snapshot(STOP_PREDICATE)
    expect(projectHeimdallFleetSnapshotForClient(source, LEGACY_CONTEXT)).toBe(source)
  })
})

describe('parallel execution fleet wire projection', () => {
  it('strips parallel summary and lane enrollment for a legacy reader', () => {
    const source = snapshot(null)
    source.entries[0]!.parallel = { runningCount: 1, effectiveMaxConcurrency: 3 }
    source.entries[0]!.entry.enrollment.kindPayload = {
      objectiveText: 'Ship it',
      tier: 'standard',
      landingBar: 'files-on-disk',
      lanesEnabled: true,
      maxConcurrency: 3,
      workspaceKind: 'git',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {}
    }

    const legacy = projectHeimdallFleetSnapshotForClient(source, LEGACY_CONTEXT)
    const capable = projectHeimdallFleetSnapshotForClient(source, PARALLEL_CONTEXT)

    expect(legacy.entries[0]).not.toHaveProperty('parallel')
    expect(legacy.entries[0]?.entry.enrollment.kindPayload).not.toHaveProperty('lanesEnabled')
    expect(capable.entries[0]?.parallel).toEqual(source.entries[0]?.parallel)
    expect(capable.entries[0]?.entry.enrollment.kindPayload).toHaveProperty('lanesEnabled', true)
  })

  it('strips gates for a legacy reader even without lane enrollment', () => {
    const source = snapshot(null)
    source.entries[0]!.entry.enrollment.kindPayload = {
      objectiveText: 'Ship it',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 3,
      workspaceKind: 'git',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {},
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    }

    const legacy = projectHeimdallFleetSnapshotForClient(source, LEGACY_CONTEXT)
    const capable = projectHeimdallFleetSnapshotForClient(source, PARALLEL_CONTEXT)

    expect(legacy.entries[0]?.entry.enrollment.kindPayload).not.toHaveProperty('gates')
    expect(capable.entries[0]?.entry.enrollment.kindPayload).toHaveProperty('gates')
  })
})

describe('projectHeimdallDetailParkReasonForClient', () => {
  it('degrades the watcher status embedded in the detail read', () => {
    const projected = projectHeimdallDetailParkReasonForClient(
      detail(CONFIGURATION_ERROR),
      LEGACY_CONTEXT
    )
    expect(projected.watcher.entry.status.parkReason).toBeNull()
  })

  it('returns the same detail reference when nothing needs degrading', () => {
    const source = detail(STOP_PREDICATE)
    expect(projectHeimdallDetailParkReasonForClient(source, LEGACY_CONTEXT)).toBe(source)
  })
})

describe('projectObjectiveDetailParallelForClient', () => {
  const source: ObjectiveDetail = {
    contract: {
      objectiveText: 'Ship it',
      tier: 'standard',
      landingBar: 'files-on-disk',
      lanesEnabled: true,
      maxConcurrency: 3,
      workspaceKind: 'git',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {},
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    },
    revisions: [],
    nodes: [
      {
        taskKey: 'task-a',
        title: 'Task A',
        revisionId: 'revision-1',
        orchestrationTaskId: null,
        dispatchId: null,
        laneTaskKeys: ['task-a', 'task-b'],
        territory: ['src/**'],
        overrunPaths: ['docs/outside.md'],
        state: 'pending',
        criteria: []
      }
    ],
    verdicts: [],
    landing: [],
    parallel: { runningCount: 0, effectiveMaxConcurrency: 3, dispatches: [] },
    planLint: {
      findings: [],
      truncated: false,
      conflictPairs: [],
      criticalPathLength: 1,
      maxWidth: 1
    },
    assumptions: [{ claim: 'The API is stable', dependentTaskKeys: [] }],
    planReviews: [
      {
        targetKind: 'revision',
        targetId: 'revision-1',
        round: 1,
        verdict: 'approve',
        summary: 'Looks solid',
        createdAtMs: 1
      }
    ],
    pendingPatch: { id: 'patch-1', status: 'pending', rejection: null, touchedTaskKeys: [] },
    gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }],
    asOfMs: 1
  }

  it('strips every parallel-only field for legacy readers', () => {
    const projected = projectObjectiveDetailParallelForClient(source, LEGACY_CONTEXT)
    expect(projected).not.toHaveProperty('parallel')
    expect(projected.contract).not.toHaveProperty('lanesEnabled')
    expect(projected.contract).not.toHaveProperty('gates')
    expect(projected.nodes[0]).not.toHaveProperty('laneTaskKeys')
    expect(projected.nodes[0]).not.toHaveProperty('territory')
    expect(projected.nodes[0]).not.toHaveProperty('overrunPaths')
    expect(projected).not.toHaveProperty('planLint')
    expect(projected).not.toHaveProperty('assumptions')
    expect(projected).not.toHaveProperty('planReviews')
    expect(projected).not.toHaveProperty('pendingPatch')
    expect(projected).not.toHaveProperty('gates')
  })

  it('strips a noGateDeclared detail without a parallel summary for legacy readers', () => {
    const { parallel: _parallel, gates: _gates, ...rest } = source
    const withoutGates: ObjectiveDetail = { ...rest, noGateDeclared: true }
    const projected = projectObjectiveDetailParallelForClient(withoutGates, LEGACY_CONTEXT)
    expect(projected).not.toHaveProperty('noGateDeclared')
  })

  it('keeps every parallel-only field for capable readers', () => {
    expect(projectObjectiveDetailParallelForClient(source, PARALLEL_CONTEXT)).toBe(source)
  })
})

describe('park-reason wire projection is exhaustive over the schema', () => {
  const PRE_CAPABILITY_KINDS = new Set([
    'budget',
    'stop-predicate',
    'worker-question',
    'coordinator-seat-lost'
  ])

  function sampleParkReason(kind: string): WatcherParkReason {
    switch (kind) {
      case 'budget':
        return { kind: 'budget', exhaustion: { kind: 'turns' } }
      case 'stop-predicate':
        return { kind: 'stop-predicate', predicateId: 'p', reason: 'r' }
      case 'worker-question':
        return { kind: 'worker-question', messageId: 'm' }
      case 'coordinator-seat-lost':
        return { kind: 'coordinator-seat-lost' }
      case 'worker-escalation':
        return { kind: 'worker-escalation', escalationId: 'e', messageId: 'm' }
      case 'configuration-error':
        return { kind: 'configuration-error', reason: 'r' }
      case 'owner-escalation':
        return { kind: 'owner-escalation', escalationId: 'e', reason: 'r' }
      default:
        throw new Error(`park-reason kind ${kind} has no sample; extend this test`)
    }
  }

  const kinds = WatcherParkReasonSchema.options.map(
    (option) => option.shape.kind.value as WatcherParkReason['kind']
  )

  it.each(kinds)(
    'degrades %s for an un-negotiated reader unless it predates the capability',
    (kind) => {
      const projected = projectWatcherListEntryForClient(
        listEntry(sampleParkReason(kind)),
        LEGACY_CONTEXT
      )
      if (PRE_CAPABILITY_KINDS.has(kind)) {
        expect(projected.status.parkReason?.kind).toBe(kind)
      } else {
        expect(projected.status.parkReason).toBeNull()
      }
    }
  )

  it.each(kinds)('preserves %s for a reader that negotiated the capability', (kind) => {
    const projected = projectWatcherListEntryForClient(
      listEntry(sampleParkReason(kind)),
      CAPABLE_CONTEXT
    )
    expect(projected.status.parkReason?.kind).toBe(kind)
  })
})
