import { describe, expect, it, vi } from 'vitest'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { EnrollInput, WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import { RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import {
  HeimdallCommandCapabilityError,
  type FleetEnvironmentTransport
} from './fleet-environment-transport'
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

function objectiveEnrollInput(
  landingBar: 'files-on-disk' | 'pushed-ref' | 'hosted-review' | 'merged' = 'files-on-disk'
): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {
      landingBar,
      roleAgents: {},
      roleLaunch: { planner: { model: 'opus', effort: 'high' } }
    }
  }
}

function hostedReviewEnrollInput(mergeCheckScope?: 'required' | 'all'): EnrollInput {
  return {
    kind: 'hosted-review',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {
      branch: 'feature/review',
      provider: 'github',
      reviewNumber: 42,
      reviewUrl: 'https://github.com/org/repo/pull/42',
      branchUpdateMode: 'merge-base-update',
      mergeMethod: null,
      ...(mergeCheckScope === undefined ? {} : { mergeCheckScope })
    }
  }
}

describe('HeimdallRemoteFleetMirrors.enroll newWorktree capability gating', () => {
  const newWorktree = { name: 'new-objective', baseBranch: 'main' }

  it.each(['unsupported', 'unknown'])(
    'refuses an %s host without sending enrollment',
    async (support) => {
      const environment = environmentHarness([HEIMDALL_COMMANDS_RUNTIME_CAPABILITY])
      if (support === 'unknown') {
        vi.mocked(environment.status).mockRejectedValueOnce(new Error('status unavailable'))
      }
      const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
      const input = {
        ...objectiveEnrollInput(),
        worktreeId: null,
        kindPayload: { newWorktree, roleAgents: {} }
      }

      await expect(mirrors.enroll(input, REMOTE_OWNER)).rejects.toThrow(
        HeimdallCommandCapabilityError
      )
      expect(environment.mutate).not.toHaveBeenCalled()
    }
  )

  it('preserves newWorktree when parallel and role-launch compatibility fields are removed', async () => {
    const environment = environmentHarness([
      HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
      HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = {
      ...objectiveEnrollInput(),
      worktreeId: null,
      kindPayload: {
        roleAgents: {},
        roleLaunch: { planner: { model: 'opus', effort: 'high' } },
        newWorktree
      }
    }

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input: { ...input, kindPayload: { roleAgents: {}, newWorktree, maxConcurrency: 1 } },
      owner: null
    })
  })

  it('sends newWorktree unchanged to a host supporting every enrollment capability', async () => {
    const environment = environmentHarness([
      HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
      HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY,
      HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
      HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = {
      ...objectiveEnrollInput(),
      worktreeId: null,
      kindPayload: {
        roleAgents: {},
        roleLaunch: { planner: { model: 'opus', effort: 'high' } },
        newWorktree
      }
    }

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input,
      owner: null
    })
  })

  it('still enrolls without newWorktree when the host does not advertise support', async () => {
    const environment = environmentHarness([HEIMDALL_COMMANDS_RUNTIME_CAPABILITY])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = objectiveEnrollInput()

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input: {
        ...input,
        kindPayload: { roleAgents: {}, maxConcurrency: 1, landingBar: 'files-on-disk' }
      },
      owner: null
    })
  })
})

describe('HeimdallRemoteFleetMirrors.enroll roleLaunch capability gating', () => {
  it('sends roleLaunch through unchanged when the remote negotiates role-launch support', async () => {
    const environment = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.parallel-execution.v1',
      'heimdall.objective-role-launch.v1',
      HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY
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
      input: { ...input, kindPayload: { roleAgents: {}, landingBar: 'files-on-disk' } },
      owner: null
    })
  })

  it('leaves below-hosted-review objective enrollment compatible with an older host', async () => {
    const environment = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.parallel-execution.v1',
      'heimdall.objective-role-launch.v1'
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = objectiveEnrollInput('pushed-ref')

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input,
      owner: null
    })
  })
})

describe('HeimdallRemoteFleetMirrors.enroll merge-check scope capability gating', () => {
  it('advertises support for hosted-review check scope', () => {
    expect(RUNTIME_CAPABILITIES).toContain(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY)
  })

  it('sends all scope unchanged for a hosted-review enrollment when the remote advertises support', async () => {
    const environment = environmentHarness([
      'heimdall.commands.v1',
      HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = hostedReviewEnrollInput('all')

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input,
      owner: null
    })
  })

  it('refuses all scope on a hosted-review enrollment when the remote does not advertise support', async () => {
    const environment = environmentHarness(['heimdall.commands.v1'])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)

    await expect(mirrors.enroll(hostedReviewEnrollInput('all'), REMOTE_OWNER)).rejects.toThrow(
      /Update the host or choose "required"/
    )
    expect(environment.mutate).not.toHaveBeenCalled()
  })

  it('treats a missing hosted-review scope as all on a remote that lacks support', async () => {
    const environment = environmentHarness(['heimdall.commands.v1'])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)

    await expect(mirrors.enroll(hostedReviewEnrollInput(), REMOTE_OWNER)).rejects.toThrow(
      /Update the host or choose "required"/
    )
    expect(environment.mutate).not.toHaveBeenCalled()
  })

  it('strips explicit required scope before enrolling a hosted review on an older host', async () => {
    const environment = environmentHarness(['heimdall.commands.v1'])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)

    await mirrors.enroll(hostedReviewEnrollInput('required'), REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input: hostedReviewEnrollInput(),
      owner: null
    })
  })

  it.each(['hosted-review', 'merged'] as const)(
    'refuses objective landing bar %s on a host that cannot honor its hosted-review handoff',
    async (landingBar) => {
      const environment = environmentHarness(['heimdall.commands.v1'])
      const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)

      await expect(mirrors.enroll(objectiveEnrollInput(landingBar), REMOTE_OWNER)).rejects.toThrow(
        /Update the host before enrolling/
      )
      expect(environment.mutate).not.toHaveBeenCalled()
    }
  )

  it('allows a hosted-review objective handoff on a host that advertises support', async () => {
    const environment = environmentHarness([
      'heimdall.commands.v1',
      'heimdall.parallel-execution.v1',
      'heimdall.objective-role-launch.v1',
      HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY
    ])
    const mirrors = new HeimdallRemoteFleetMirrors(environment, () => undefined)
    const input = objectiveEnrollInput('hosted-review')

    await mirrors.enroll(input, REMOTE_OWNER)

    expect(environment.mutate).toHaveBeenCalledWith(REMOTE_IDENTITY, 'heimdall:enroll', {
      input,
      owner: null
    })
  })
})
