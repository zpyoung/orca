import { describe, expect, it } from 'vitest'
import { HEIMDALL_PIPELINE_RUNTIME_CAPABILITY } from '../../shared/fork-heimdall-pipeline/capability'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherCommandRequest } from '../../shared/fork-heimdall/fleet-types'
import {
  enrollmentForParallelCompatibility,
  sendRemoteWatcherCommand
} from './fleet-remote-operations'
import {
  HeimdallCommandCapabilityError,
  type FleetEnvironmentTransport
} from './fleet-environment-transport'

function input(kindPayload: Record<string, unknown>): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 12 },
    kindPayload
  }
}

describe('enrollmentForParallelCompatibility', () => {
  it('strips lanesEnabled and gates and clamps concurrency for a peer without the capability', () => {
    const enrollment = input({
      maxConcurrency: 5,
      lanesEnabled: true,
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    })

    const compatible = enrollmentForParallelCompatibility(enrollment, false)

    expect(compatible.kindPayload).toEqual({ maxConcurrency: 1 })
  })

  it('leaves the enrollment untouched when the peer supports parallel execution', () => {
    const enrollment = input({
      maxConcurrency: 5,
      lanesEnabled: true,
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    })

    expect(enrollmentForParallelCompatibility(enrollment, true)).toBe(enrollment)
  })

  it('leaves a non-objective enrollment untouched', () => {
    const enrollment: EnrollInput = {
      kind: 'hosted-review',
      repoId: 'repo-1',
      worktreeId: null,
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: { gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }] }
    }

    expect(enrollmentForParallelCompatibility(enrollment, false)).toBe(enrollment)
  })

  it('leaves an enrollment without gates or lanes untouched beyond the concurrency clamp', () => {
    const enrollment = input({ maxConcurrency: 5 })

    expect(enrollmentForParallelCompatibility(enrollment, false).kindPayload).toEqual({
      maxConcurrency: 1
    })
  })
})
describe('sendRemoteWatcherCommand pipeline capability gating', () => {
  it('returns the runtime capability refusal from the mutation preflight', async () => {
    const environments: FleetEnvironmentTransport = {
      list: () => [],
      availability: () => 'available',
      status: async () => {
        throw new Error('unused')
      },
      read: async () => {
        throw new Error('unused')
      },
      mutate: async (_identity, _method, _params, requiredCapability) => {
        if (requiredCapability !== HEIMDALL_PIPELINE_RUNTIME_CAPABILITY) {
          throw new Error('The pipeline capability was not checked before sending the command.')
        }
        throw new HeimdallCommandCapabilityError(HEIMDALL_PIPELINE_RUNTIME_CAPABILITY)
      },
      subscribe: async () => {
        throw new Error('unused')
      }
    }
    const request: WatcherCommandRequest = {
      target: { watcherId: 'watcher-1', connectionId: 'environment-1', pairingRevision: 7 },
      expectedOwner: {
        executionHostId: 'local',
        schedulerOwner: 'local_host_service',
        workspaceKey: 'local::/repo',
        revision: 1
      },
      command: {
        kind: 'answer-pipeline-choice',
        scope: {
          actionKind: 'pipeline-pass-gate',
          contentIdentity: `pipeline:sha256:${'a'.repeat(64)}`,
          evidenceKey: 'pipeline-choice'
        },
        choice: 'approve'
      }
    }
    let unsupported = false

    const result = await sendRemoteWatcherCommand(
      environments,
      { id: 'environment-1', pairingRevision: 7 },
      request,
      () => {
        unsupported = true
      }
    )

    expect(result).toEqual({
      status: 'refused',
      reason: 'unsupported-capability',
      detail:
        'The owning runtime does not support Heimdall pipelines. Update the host and try again.'
    })
    expect(unsupported).toBe(true)
  })
})
