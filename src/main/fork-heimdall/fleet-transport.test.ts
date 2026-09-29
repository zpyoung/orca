import { describe, expect, it, vi } from 'vitest'
import {
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  HeimdallFleetSnapshot,
  WatcherCommandRequest,
  WatcherDetail,
  WatcherFleetEntry
} from '../../shared/fork-heimdall/fleet-types'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE } from '../../shared/fork-heimdall/enrollment-refusal-error'
import {
  HeimdallEnrollOwnerCapabilityError,
  type FleetEnvironmentSubscriptionCallbacks,
  type FleetEnvironmentTransport
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
    result: {
      runtimeId: 'runtime-remote',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities
    },
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
    enroll: vi.fn<HeimdallFleetKernel['enroll']>(),
    fleet: vi
      .fn<HeimdallFleetKernel['fleet']>()
      .mockResolvedValue({ entries: [], generatedAtMs: 1 }),
    detail: vi.fn<HeimdallFleetKernel['detail']>(),
    command: vi.fn<HeimdallFleetKernel['command']>(),
    debugReport: vi.fn<HeimdallFleetKernel['debugReport']>(),
    subscribe: vi.fn<HeimdallFleetKernel['subscribe']>(() => vi.fn())
  }
}

function environmentHarness(capabilities = ['heimdall.commands.v1']): {
  environment: FleetEnvironmentTransport
  setPairingRevision(revision: number): void
  setAvailability(availability: 'available' | 'disconnected'): void
  setDetail(detail: WatcherDetail): void
  refuseDetails(message: string): void
  callbacks(): FleetEnvironmentSubscriptionCallbacks
  failReads(error: Error): void
} {
  let pairingRevision = 7
  let availability: 'available' | 'disconnected' = 'available'
  let readError: Error | null = null
  let detailResponse: RuntimeRpcResponse<unknown> | null = null
  let subscriptionCallbacks: FleetEnvironmentSubscriptionCallbacks | null = null
  const environment: FleetEnvironmentTransport = {
    list: () => [{ id: 'environment-1', pairingRevision }],
    availability: (identity) =>
      identity.pairingRevision === pairingRevision ? availability : 'replaced',
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
    setAvailability: (nextAvailability) => {
      availability = nextAvailability
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
function deleteCommandRequest(): WatcherCommandRequest {
  return { ...commandRequest(), command: { kind: 'delete' } }
}
function answerEscalationCommandRequest(): WatcherCommandRequest {
  return {
    ...commandRequest(),
    command: { kind: 'answer-escalation', escalationId: 'escalation-1', body: 'Use main.' }
  }
}

const REMOTE_OWNER = { connectionId: 'environment-1', pairingRevision: 7 }

function enrollInput(owner?: EnrollInput['owner']): EnrollInput {
  return {
    kind: 'hosted-review',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    owner
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
    const pushed: HeimdallFleetSnapshot[] = []
    transport.subscribe((next) => pushed.push(next))

    const fleet = await transport.fleet()

    expect(fleet.entries).toEqual([])
    await vi.waitFor(() => {
      expect(pushed.at(-1)?.entries[0]).toMatchObject({
        target: {
          watcherId: 'watcher-1',
          connectionId: 'environment-1',
          pairingRevision: 7
        },
        contact: 'live',
        readOnlyReason: expect.stringContaining('does not support Heimdall commands')
      })
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
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())

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
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
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
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
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

  it('refuses permanent deletion before sending to an older owner', async () => {
    const remote = environmentHarness(['heimdall.commands.v1'])
    const local = kernel()
    const transport = new HeimdallFleetTransport({
      kernel: local,
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())

    await expect(transport.command(deleteCommandRequest())).resolves.toMatchObject({
      status: 'refused',
      reason: 'unsupported-capability',
      detail: expect.stringContaining('permanent watcher deletion')
    })
    expect(remote.environment.mutate).not.toHaveBeenCalled()
    expect(local.command).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('negotiates the deletion capability again when sending the destructive command', async () => {
    const remote = environmentHarness([
      'heimdall.commands.v1',
      HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
    ])
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
    const request = deleteCommandRequest()

    await expect(transport.command(request)).resolves.toMatchObject({ status: 'applied' })
    expect(remote.environment.mutate).toHaveBeenCalledWith(
      { id: 'environment-1', pairingRevision: 7 },
      'heimdall:command',
      {
        ...request,
        target: { watcherId: 'watcher-1', connectionId: null, pairingRevision: null }
      },
      HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
    )
    transport.dispose()
  })

  it('refuses answering an owner escalation before sending to an older owner', async () => {
    const remote = environmentHarness(['heimdall.commands.v1'])
    const local = kernel()
    const transport = new HeimdallFleetTransport({
      kernel: local,
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())

    await expect(transport.command(answerEscalationCommandRequest())).resolves.toMatchObject({
      status: 'refused',
      reason: 'unsupported-capability',
      detail: expect.stringContaining('owner escalation')
    })
    expect(remote.environment.mutate).not.toHaveBeenCalled()
    expect(local.command).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('sends an answer-escalation command once the remote negotiates the capability', async () => {
    const remote = environmentHarness([
      'heimdall.commands.v1',
      HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY
    ])
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
    const request = answerEscalationCommandRequest()

    await expect(transport.command(request)).resolves.toMatchObject({ status: 'applied' })
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

  it('routes a remote command with a local owner target and the original owner fence', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await transport.fleet()
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
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
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())

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
    await vi.waitFor(() => expect(() => remote.callbacks()).not.toThrow())
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

  it('returns local fleet state while one deduplicated remote refresh remains unresolved', async () => {
    const unresolved = new Promise<never>(() => {})
    const environments: FleetEnvironmentTransport = {
      list: () => [{ id: 'environment-1', pairingRevision: 7 }],
      availability: () => 'available',
      status: vi.fn(() => unresolved),
      read: vi.fn(() => unresolved),
      mutate: vi.fn(async () =>
        successful('heimdall:command', { status: 'applied', appliedAtMs: 20 })
      ),
      subscribe: vi.fn(async () => ({
        requestId: 'remote-subscription',
        close: vi.fn(),
        sendBinary: () => false
      }))
    }
    const localKernel = kernel()
    vi.mocked(localKernel.fleet).mockResolvedValue(snapshot())
    const transport = new HeimdallFleetTransport({
      kernel: localKernel,
      userDataPath: () => '/unused',
      environments
    })

    const first = await transport.fleet()
    const second = await transport.fleet()

    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]?.target).toEqual(LOCAL_TARGET)
    expect(second.entries[0]?.target).toEqual(LOCAL_TARGET)
    expect(environments.status).toHaveBeenCalledOnce()
    expect(environments.read).toHaveBeenCalledOnce()
    transport.dispose()
  })

  it('does not publish a remote refresh which settles after disposal', async () => {
    const remote = environmentHarness()
    const remoteRead = Promise.withResolvers<RuntimeRpcResponse<unknown>>()
    vi.mocked(remote.environment.read).mockReturnValue(remoteRead.promise)
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    const pushed: HeimdallFleetSnapshot[] = []
    transport.subscribe((next) => pushed.push(next))

    await transport.fleet()
    transport.dispose()
    remoteRead.resolve(successful('heimdall:fleet', snapshot()))
    await remoteRead.promise
    await Promise.resolve()
    await Promise.resolve()

    expect(pushed).toEqual([])
  })

  it('serves a cached remote owner as unverifiable as soon as its environment is unavailable', async () => {
    const remote = environmentHarness()
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    const pushed: HeimdallFleetSnapshot[] = []
    transport.subscribe((next) => pushed.push(next))
    await transport.fleet()
    await vi.waitFor(() => expect(pushed.at(-1)?.entries[0]?.contact).toBe('live'))

    remote.setAvailability('disconnected')
    const cached = await transport.fleet()

    expect(cached.entries[0]).toMatchObject({
      contact: 'unverifiable',
      readOnlyReason: expect.stringContaining('last confirmed state')
    })
    expect(remote.environment.read).toHaveBeenCalledOnce()
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

  it('downgrades objective concurrency when enrolling against an older remote', async () => {
    const remote = environmentHarness(['heimdall.commands.v1'])
    remote.environment.mutate = vi.fn(async () =>
      successful('heimdall:enroll', { status: 'enrolled', entry: fleetEntry().entry })
    )
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    const input: EnrollInput = {
      ...enrollInput(undefined),
      kind: 'objective',
      kindPayload: { lanesEnabled: true, maxConcurrency: 3, objective: 'Keep this field' }
    }

    const result = await transport.enroll(input, REMOTE_OWNER)

    expect(result.status).toBe('enrolled')
    expect(remote.environment.mutate).toHaveBeenCalledWith(
      { id: 'environment-1', pairingRevision: 7 },
      'heimdall:enroll',
      {
        input: {
          ...input,
          kindPayload: { maxConcurrency: 1, objective: 'Keep this field' }
        },
        owner: null
      }
    )
    transport.dispose()
  })

  it('preserves objective concurrency when the remote advertises parallel execution', async () => {
    const remote = environmentHarness([
      'heimdall.commands.v1',
      HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
    ])
    remote.environment.mutate = vi.fn(async () =>
      successful('heimdall:enroll', { status: 'enrolled', entry: fleetEntry().entry })
    )
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    const input: EnrollInput = {
      ...enrollInput(undefined),
      kind: 'objective',
      kindPayload: { lanesEnabled: false, maxConcurrency: 4 }
    }

    const result = await transport.enroll(input, REMOTE_OWNER)

    expect(result.status).toBe('enrolled')
    expect(remote.environment.mutate).toHaveBeenCalledWith(
      { id: 'environment-1', pairingRevision: 7 },
      'heimdall:enroll',
      { input, owner: null }
    )
    transport.dispose()
  })

  it('refuses to enroll an owner against a remote that has not negotiated owner support', async () => {
    const remote = environmentHarness(['heimdall.commands.v1'])
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })

    await expect(transport.enroll(enrollInput({ agent: 'claude' }), REMOTE_OWNER)).rejects.toThrow(
      HeimdallEnrollOwnerCapabilityError
    )
    expect(remote.environment.mutate).not.toHaveBeenCalled()
    transport.dispose()
  })

  it('lets an ownerless enroll through a remote that has not negotiated owner support', async () => {
    const remote = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.hosted-review-check-scope.v1'
    ])
    remote.environment.mutate = vi.fn(async () =>
      successful('heimdall:enroll', { status: 'enrolled', entry: fleetEntry().entry })
    )
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })

    const result = await transport.enroll(enrollInput(undefined), REMOTE_OWNER)

    expect(result.status).toBe('enrolled')
    transport.dispose()
  })

  it('sends the owner selection once the remote negotiates owner support', async () => {
    const remote = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.enroll-owner.v1',
      'heimdall.hosted-review-check-scope.v1'
    ])
    remote.environment.mutate = vi.fn(async () =>
      successful('heimdall:enroll', { status: 'enrolled', entry: fleetEntry().entry })
    )
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })

    const result = await transport.enroll(enrollInput({ agent: 'claude' }), REMOTE_OWNER)

    expect(result.status).toBe('enrolled')
    expect(remote.environment.mutate).toHaveBeenCalledWith(
      { id: 'environment-1', pairingRevision: 7 },
      'heimdall:enroll',
      { input: enrollInput({ agent: 'claude' }), owner: null }
    )
    transport.dispose()
  })

  it('preserves structured refusal data through local and remote enrollment transports', async () => {
    const refusal = {
      status: 'refused',
      reason: 'duplicate-workspace',
      existingWatcherId: 'existing-1'
    } as const
    const localKernel = kernel()
    localKernel.enroll = vi.fn(async () => refusal)
    const localTransport = new HeimdallFleetTransport({
      kernel: localKernel,
      userDataPath: () => '/unused'
    })
    await expect(localTransport.enroll(enrollInput(undefined))).rejects.toMatchObject({
      code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
      data: refusal
    })
    localTransport.dispose()

    const remote = environmentHarness()
    remote.environment.mutate = vi.fn(async () => ({
      id: 'heimdall:enroll',
      ok: false as const,
      error: {
        code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
        message:
          'Heimdall enrollment refused: duplicate-workspace: watcher existing-1 already owns this workspace',
        data: refusal
      },
      _meta: { runtimeId: 'runtime-remote' }
    }))
    const remoteTransport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    await expect(
      remoteTransport.enroll(enrollInput(undefined), REMOTE_OWNER)
    ).rejects.toMatchObject({
      code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
      data: refusal
    })
    remoteTransport.dispose()
  })

  it('rejects unallowlisted remote refusal fields without forwarding them', async () => {
    const remote = environmentHarness()
    remote.environment.mutate = vi.fn(async () => ({
      id: 'heimdall:enroll',
      ok: false as const,
      error: {
        code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
        message: 'Heimdall enrollment refused: duplicate-workspace',
        data: {
          status: 'refused',
          reason: 'duplicate-workspace',
          existingWatcherId: 'existing-1',
          privateDetail: 'private-detail'
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    }))
    const transport = new HeimdallFleetTransport({
      kernel: kernel(),
      userDataPath: () => '/unused',
      environments: remote.environment
    })
    const failure = await transport
      .enroll(enrollInput(undefined), REMOTE_OWNER)
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) {
      throw new Error('Expected an invalid remote refusal error')
    }
    expect(failure.message).toBe(
      'The owning runtime returned an invalid Heimdall enrollment refusal.'
    )
    expect(failure).not.toHaveProperty('data')
    transport.dispose()
  })
})
