import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../../../../shared/fork-heimdall/api'
import { HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY } from '../../../../../shared/fork-heimdall/capability'
import {
  NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  RUNTIME_CAPABILITIES
} from '../../../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../../../shared/remote-runtime-client-capabilities'
import type {
  HeimdallFleetSnapshot,
  WatcherDetail
} from '../../../../../shared/fork-heimdall/fleet-types'
import type {
  EnrollResult,
  WatcherListEntry,
  WatcherParkReason
} from '../../../../../shared/fork-heimdall/watcher-types'
import { eraseRpcMethods, isStreamingMethod, type RpcContext, type RpcMethod } from '../../core'
import { HEIMDALL_METHODS } from './heimdall'
import { bindHeimdallKernel, bindHeimdallTransport } from './kernel-binding'

const WORKER_ESCALATION: WatcherParkReason = {
  kind: 'worker-escalation',
  escalationId: 'escalation-1',
  messageId: 'message-1'
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

function snapshot(parkReason: WatcherParkReason | null): HeimdallFleetSnapshot {
  return { entries: [fleetEntry(parkReason)], generatedAtMs: 1 }
}

function method(name: string): RpcMethod {
  const found = eraseRpcMethods(HEIMDALL_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing Heimdall RPC method ${name}`)
  }
  return found
}

async function call(
  runtime: object,
  name: string,
  params: unknown,
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'> = {}
): Promise<unknown> {
  const target = method(name)
  return await target.handler(target.params?.parse(params), {
    runtime: runtime as never,
    ...context
  })
}

function harness() {
  const runtime = {}
  const kernel = {
    enroll: vi.fn(async (): Promise<EnrollResult> => ({
      status: 'enrolled' as const,
      entry: listEntry(WORKER_ESCALATION)
    })),
    fleet: vi.fn(async () => snapshot(WORKER_ESCALATION)),
    detail: vi.fn(async () => ({
      watcher: fleetEntry(WORKER_ESCALATION),
      ledger: { watcherId: 'watcher-1', entries: [] },
      traces: [],
      workers: []
    })),
    subscribe: vi.fn(() => (): void => undefined)
  }
  // The renderer's in-process reads route through the transport, never the kernel directly.
  const transport = {
    fleet: vi.fn(async () => snapshot(WORKER_ESCALATION)),
    detail: vi.fn(async () => ({
      watcher: fleetEntry(WORKER_ESCALATION),
      ledger: { watcherId: 'watcher-1', entries: [] },
      traces: [],
      workers: []
    })),
    enroll: vi.fn(async (): Promise<EnrollResult> => ({
      status: 'enrolled' as const,
      entry: listEntry(WORKER_ESCALATION)
    }))
  }
  bindHeimdallKernel(runtime, kernel as never)
  bindHeimdallTransport(runtime, transport as never)
  return { runtime, kernel, transport }
}

const LEGACY_CONTEXT = { clientKind: 'runtime' as const, clientCapabilities: [] }
const CAPABLE_CONTEXT = {
  clientKind: 'runtime' as const,
  clientCapabilities: [HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY]
}

describe('Heimdall watcher park reason capability gating', () => {
  it('degrades a worker-escalation park reason on fleet reads without the capability', async () => {
    const { runtime } = harness()
    const legacy = (await call(
      runtime,
      HEIMDALL_CHANNELS.fleet,
      {},
      LEGACY_CONTEXT
    )) as HeimdallFleetSnapshot
    const capable = (await call(
      runtime,
      HEIMDALL_CHANNELS.fleet,
      {},
      CAPABLE_CONTEXT
    )) as HeimdallFleetSnapshot

    expect(legacy.entries[0]?.entry.status.parkReason).toBeNull()
    expect(capable.entries[0]?.entry.status.parkReason).toEqual(WORKER_ESCALATION)
  })

  it('degrades a worker-escalation park reason on detail reads without the capability', async () => {
    const { runtime } = harness()
    const target = { watcherId: 'watcher-1', connectionId: null, pairingRevision: null }
    const legacy = (await call(
      runtime,
      HEIMDALL_CHANNELS.detail,
      target,
      LEGACY_CONTEXT
    )) as WatcherDetail
    const capable = (await call(
      runtime,
      HEIMDALL_CHANNELS.detail,
      target,
      CAPABLE_CONTEXT
    )) as WatcherDetail

    expect(legacy.watcher.entry.status.parkReason).toBeNull()
    expect(capable.watcher.entry.status.parkReason).toEqual(WORKER_ESCALATION)
  })

  it('degrades a worker-escalation park reason on the enrolled entry without the capability', async () => {
    const { runtime } = harness()
    const input = {
      input: {
        kind: 'objective' as const,
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        capabilities: {},
        budget: { wallClockActiveMs: null, turns: null },
        kindPayload: {}
      },
      owner: null
    }
    const legacy = (await call(runtime, HEIMDALL_CHANNELS.enroll, input, LEGACY_CONTEXT)) as {
      entry: WatcherListEntry
    }
    const capable = (await call(runtime, HEIMDALL_CHANNELS.enroll, input, CAPABLE_CONTEXT)) as {
      entry: WatcherListEntry
    }

    expect(legacy.entry.status.parkReason).toBeNull()
    expect(capable.entry.status.parkReason).toEqual(WORKER_ESCALATION)
  })

  it('never degrades an in-process read', async () => {
    const { runtime } = harness()
    const local = (await call(runtime, HEIMDALL_CHANNELS.fleet, {})) as HeimdallFleetSnapshot
    expect(local.entries[0]?.entry.status.parkReason).toEqual(WORKER_ESCALATION)
  })

  it('degrades the initial subscribe snapshot for a reader without the capability', async () => {
    const { runtime } = harness()
    const cleanups: (() => void)[] = []
    Object.assign(runtime, {
      registerSubscriptionCleanup: (_id: string, cleanup: () => void) => cleanups.push(cleanup)
    })
    const subscribeMethod = eraseRpcMethods(HEIMDALL_METHODS).find(
      (candidate) => candidate.name === HEIMDALL_CHANNELS.subscribe && isStreamingMethod(candidate)
    )
    if (!subscribeMethod || !isStreamingMethod(subscribeMethod)) {
      throw new Error('Missing Heimdall subscribe method')
    }
    const emitted: unknown[] = []
    const done = subscribeMethod.handler(
      {},
      { runtime: runtime as never, connectionId: 'conn-1', ...LEGACY_CONTEXT },
      (result) => emitted.push(result)
    )
    // The handler computes the ready snapshot through an async `kernel.fleet()` call before
    // emitting it; calling cleanup before that settles sets `closed` first, and the handler
    // drops the emission it was mid-flight to send.
    await vi.waitFor(() => {
      expect(emitted.some((event) => (event as { type: string }).type === 'ready')).toBe(true)
    })
    cleanups.forEach((cleanup) => cleanup())
    await done

    const ready = emitted.find((event) => (event as { type: string }).type === 'ready') as {
      snapshot: HeimdallFleetSnapshot
    }
    expect(ready.snapshot.entries[0]?.entry.status.parkReason).toBeNull()
  })

  it('registers the capability on both the advertising and negotiating sides', () => {
    expect(RUNTIME_CAPABILITIES).toContain(HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY)
    expect(NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
    )
    expect(remoteRuntimeClientCapabilities()).toContain(
      HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
    )
  })
})
