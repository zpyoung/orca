import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { EnrollInput, WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import type { FleetEnvironmentTransport } from './fleet-environment-transport'
import { HeimdallRemoteFleetMirrors } from './fleet-remote-mirrors'

const REMOTE_IDENTITY = { id: 'environment-1', pairingRevision: 7 }
const REMOTE_OWNER = { connectionId: 'environment-1', pairingRevision: 7 }

function watcherEntry(): WatcherListEntry {
  return {
    name: 'Objective one',
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
      commandRevision: 3,
      capabilities: { plan: 'gated', implement: 'on', review: 'on', check: 'on', land: 'on' },
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
  }
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

function environmentHarness(capabilities: string[]): FleetEnvironmentTransport {
  return {
    list: () => [REMOTE_IDENTITY],
    availability: () => 'available',
    status: vi.fn(async () => runtimeStatus(capabilities)),
    read: vi.fn(async () => successful('heimdall:fleet', { entries: [], generatedAtMs: 1 })),
    mutate: vi.fn(async () =>
      successful('heimdall:enroll', { status: 'enrolled', entry: watcherEntry() })
    ),
    subscribe: vi.fn(async () => ({ requestId: 'sub', close: vi.fn(), sendBinary: () => false }))
  }
}

function objectiveEnrollInput(): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {
      roleAgents: {},
      roleLaunch: { planner: { model: 'opus', effort: 'high' } }
    }
  }
}

describe('HeimdallRemoteFleetMirrors.enroll roleLaunch capability gating', () => {
  it('sends roleLaunch through unchanged when the remote negotiates role-launch support', async () => {
    const environment = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.parallel-execution.v1',
      'heimdall.objective-role-launch.v1'
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = objectiveEnrollInput()

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input,
      owner: null
    })
  })

  it('strips roleLaunch when the remote has not negotiated role-launch support', async () => {
    const environment = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.parallel-execution.v1'
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = objectiveEnrollInput()

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input: { ...input, kindPayload: { roleAgents: {} } },
      owner: null
    })
  })

  it('leaves a non-objective enrollment untouched regardless of role-launch support', async () => {
    const environment = environmentHarness(['heimdall.commands.v1'])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input: EnrollInput = {
      kind: 'hosted-review',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: {}
    }

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input,
      owner: null
    })
  })
})
