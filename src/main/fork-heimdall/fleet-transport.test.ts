import { describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  HeimdallFleetSnapshot,
  WatcherCommandRequest,
  WatcherDetail,
  WatcherFleetEntry
} from '../../shared/fork-heimdall/fleet-types'
import type {
  FleetEnvironmentSubscriptionCallbacks,
  FleetEnvironmentTransport
} from './fleet-environment-transport'
import { HeimdallFleetTransport, type HeimdallFleetKernel } from './fleet-transport'

const LOCAL_TARGET = { watcherId: 'watcher-1', connectionId: null, pairingRevision: null }

function fleetEntry(name = 'Watcher one'): WatcherFleetEntry {
  return {
    target: LOCAL_TARGET,
    entry: {
      name,
      enrollment: {
        watcherId: 'watcher-1',
        kind: 'hosted-review',
        workspaceKey: 'local::/repo',
        executionHostId: 'local',
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        workspacePath: '/repo',
        schedulerOwner: 'local_host_service',
        enabled: true,
        paused: false,
        commandRevision: 3,
        capabilities: { merge: 'gated' },
        budget: { wallClockActiveMs: 60_000, turns: 4 },
        kindPayload: {},
        coordinatorIdentity: { handle: 'coordinator-1', paneKey: 'pane-1' },
        orchestrationRunId: null,
        createdAtMs: 1,
        terminalAtMs: null
      },
      status: {
        watcherId: 'watcher-1',
        enabled: true,
        state: 'watching',
        phase: 'observe',
        reason: null,
        parkReason: null,
        budget: { activeMs: 100, turns: 1, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: 10,
        nextPulseAtMs: 20
      }
    },
    ownerFence: {
      executionHostId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceKey: 'local::/repo',
      revision: 3
    },
    observedAtMs: 10,
    contact: 'live',
    readOnlyReason: null,
    capabilityNotes: [],
    paused: false
  }
}

function snapshot(generatedAtMs = 10, name = 'Watcher one'): HeimdallFleetSnapshot {
  return { entries: [fleetEntry(name)], generatedAtMs }
}

function runtimeStatus(capabilities: string[]): RuntimeRpcResponse<RuntimeStatus> {
  return {
    id: 'status.get',
    ok: true,
    result: { capabilities } as RuntimeStatus,
    _meta: { runtimeId: 'runtime-remote' }
  }
}

function successful<T>(id: string, result: T): RuntimeRpcResponse<T> {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime-remote' } }
}

function failed(id: string, message: string): RuntimeRpcResponse<unknown> {
  return {
    id,
    ok: false,
    error: { code: 'runtime_error', message },
    _meta: { runtimeId: 'runtime-remote' }
  }
}

function watcherDetail(watcher: WatcherFleetEntry): WatcherDetail {
  return {
    watcher,
    ledger: { watcherId: watcher.target.watcherId, entries: [] },
    traces: [],
    workers: []
  }
}

function kernel(): HeimdallFleetKernel {
  return {
    enroll: vi.fn(),
    fleet: vi.fn().mockResolvedValue({ entries: [], generatedAtMs: 1 }),
    detail: vi.fn(),
    command: vi.fn(),
    debugReport: vi.fn(),
    subscribe: vi.fn(() => vi.fn())
  } as unknown as HeimdallFleetKernel
}

function environmentHarness(capabilities = ['heimdall.commands.v1']): {
  environment: FleetEnvironmentTransport
  setPairingRevision(revision: number): void
  setDetail(detail: WatcherDetail): void
  refuseDetails(message: string): void
  callbacks(): FleetEnvironmentSubscriptionCallbacks
  failReads(error: Error): void
} {
  let pairingRevision = 7
  let readError: Error | null = null
  let detailResponse: RuntimeRpcResponse<unknown> | null = null
  let subscriptionCallbacks: FleetEnvironmentSubscriptionCallbacks | null = null
  const environment: FleetEnvironmentTransport = {
    list: () => [{ id: 'environment-1', pairingRevision }],
    availability: (identity) =>
      identity.pairingRevision === pairingRevision ? 'available' : 'replaced',
    status: vi.fn(async () => runtimeStatus(capabilities)),
    read: vi.fn(async (_identity, method) => {
      if (readError) {
        throw readError
      }
      if (method === 'heimdall:detail' && detailResponse) {
        return detailResponse
      }
      return successful('heimdall:fleet', snapshot())
    }),
    mutate: vi.fn(async () =>
      successful('heimdall:command', { status: 'applied', appliedAtMs: 20 })
    ),
    subscribe: vi.fn(async (_identity, _method, _params, callbacks) => {
      subscriptionCallbacks = callbacks
      return { requestId: 'remote-subscription', close: vi.fn(), sendBinary: () => false }
    })
  }
  return {
    environment,
    setPairingRevision: (revision) => {
      pairingRevision = revision
    },
    setDetail: (detail) => {
      detailResponse = successful('heimdall:detail', detail)
    },
    refuseDetails: (message) => {
      detailResponse = failed('heimdall:detail', message)
    },
    callbacks: () => {
      if (!subscriptionCallbacks) {
        throw new Error('subscription not started')
      }
      return subscriptionCallbacks
    },
    failReads: (error) => {
      readError = error
    }
  }
}

function commandRequest(): WatcherCommandRequest {
  return {
    target: { watcherId: 'watcher-1', connectionId: 'environment-1', pairingRevision: 7 },
    expectedOwner: fleetEntry().ownerFence,
    command: { kind: 'pause' }
  }
}

describe('HeimdallFleetTransport', () => {
  it('mirrors remote reads without command capability and states why controls are unavailable', async () => {
    const remote = environmentHarness([])
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment,
      now: () => 100
    })

    const fleet = await transport.fleet()

    expect(fleet.entries).toHaveLength(1)
    expect(fleet.entries[0]).toMatchObject({
      target: {
        watcherId: 'watcher-1',
        connectionId: 'environment-1',
        pairingRevision: 7
      },
      contact: 'live',
      readOnlyReason: expect.stringContaining('does not support Heimdall commands')
    })
    expect(remote.environment.read).toHaveBeenCalledWith(
      { id: 'environment-1', pairingRevision: 7 },
      'heimdall:fleet',
      {}
    )
    transport.dispose()
  })

  it('retains the last confirmed projection as unverifiable when its subscription loses contact', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment,
      now: () => 100
    })
    const pushed: HeimdallFleetSnapshot[] = []
    transport.subscribe((next) => pushed.push(next))
    await transport.fleet()
    await Promise.resolve()

    remote.callbacks().onError({ code: 'remote_runtime_unavailable', message: 'offline' })

    await vi.waitFor(() => {
      expect(pushed.at(-1)?.entries[0]).toMatchObject({
        observedAtMs: 10,
        contact: 'unverifiable',
        readOnlyReason: expect.stringContaining('last confirmed state')
      })
    })
    transport.dispose()
  })

  it('accepts an equal or lower owner generation after a subscription reconnect', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment,
      now: () => 100
    })
    const pushed: HeimdallFleetSnapshot[] = []
    transport.subscribe((next) => pushed.push(next))
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())

    remote.callbacks().onError({ code: 'remote_runtime_unavailable', message: 'offline' })
    await vi.waitFor(() => expect(pushed.at(-1)?.entries[0]?.contact).toBe('unverifiable'))

    remote.callbacks().onResponse(
      successful('remote-subscription', {
        type: 'ready',
        subscriptionId: 'reconnected-subscription',
        snapshot: snapshot(5, 'Recovered owner')
      })
    )

    await vi.waitFor(() => {
      expect(pushed.at(-1)?.entries[0]).toMatchObject({
        entry: { name: 'Recovered owner' },
        contact: 'live'
      })
    })
    transport.dispose()
  })

  it('keeps an authenticated owner reachable when it refuses one detail read', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    remote.refuseDetails('watcher missing')

    await expect(
      transport.detail({
        watcherId: 'watcher-1',
        connectionId: 'environment-1',
        pairingRevision: 7
      })
    ).rejects.toThrow('watcher missing')
    await expect(transport.command(commandRequest())).resolves.toMatchObject({
      status: 'applied'
    })
    transport.dispose()
  })

  it('preserves a freshly read owner fence and status in routed detail', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    const freshWatcher = fleetEntry('Fresh owner detail')
    freshWatcher.ownerFence = { ...freshWatcher.ownerFence, revision: 4 }
    freshWatcher.entry.enrollment.commandRevision = 4
    freshWatcher.observedAtMs = 20
    remote.setDetail(watcherDetail(freshWatcher))

    await expect(
      transport.detail({
        watcherId: 'watcher-1',
        connectionId: 'environment-1',
        pairingRevision: 7
      })
    ).resolves.toMatchObject({
      watcher: {
        target: {
          watcherId: 'watcher-1',
          connectionId: 'environment-1',
          pairingRevision: 7
        },
        entry: {
          name: 'Fresh owner detail',
          enrollment: { commandRevision: 4 }
        },
        ownerFence: { revision: 4 },
        observedAtMs: 20
      }
    })
    transport.dispose()
  })

  it('refuses a known-disconnected command before send', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    const pushed: HeimdallFleetSnapshot[] = []
    transport.subscribe((next) => pushed.push(next))
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
    remote.callbacks().onError({ code: 'remote_runtime_unavailable', message: 'offline' })
    await vi.waitFor(() => expect(pushed.at(-1)?.entries[0]?.contact).toBe('unverifiable'))

    await expect(transport.command(commandRequest())).resolves.toMatchObject({
      status: 'refused',
      reason: 'owner-unreachable'
    })
    expect(remote.environment.mutate).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('routes a remote command with a local owner target and the original owner fence', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    const request = commandRequest()

    await expect(transport.command(request)).resolves.toEqual({
      status: 'applied',
      appliedAtMs: 20
    })
    expect(remote.environment.mutate).toHaveBeenCalledWith(
      { id: 'environment-1', pairingRevision: 7 },
      'heimdall:command',
      {
        ...request,
        target: { watcherId: 'watcher-1', connectionId: null, pairingRevision: null }
      }
    )
    transport.dispose()
  })

  it('reports a post-send transport loss as indeterminate', async () => {
    const remote = environmentHarness()
    vi.mocked(remote.environment.mutate).mockRejectedValue(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'connection closed', {
        pairingStage: 'runtime'
      })
    )
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()

    await expect(transport.command(commandRequest())).resolves.toMatchObject({
      status: 'indeterminate',
      detail: expect.stringContaining('may or may not have taken effect')
    })
    transport.dispose()
  })

  it('fences a same-id re-pair with the row revision captured before replacement', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    remote.setPairingRevision(8)
    remote.failReads(new Error('replacement has not published yet'))
    await transport.fleet()

    await expect(transport.command(commandRequest())).resolves.toMatchObject({
      status: 'refused',
      reason: 'owner-conflict'
    })
    expect(remote.environment.mutate).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('allocates monotonic snapshots when the wall clock does not advance', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment,
      now: () => 100
    })

    const first = await transport.fleet()
    const second = await transport.fleet()

    expect(second.generatedAtMs).toBeGreaterThan(first.generatedAtMs)
    transport.dispose()
  })
})
