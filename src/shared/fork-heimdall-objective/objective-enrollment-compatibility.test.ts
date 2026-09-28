import { describe, expect, it } from 'vitest'
import {
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../fork-heimdall/capability'
import type { ObjectiveEnrollmentPayload } from './contract-types'
import { adaptObjectiveEnrollmentToCapabilities } from './objective-enrollment-compatibility'

const payload: ObjectiveEnrollmentPayload = {
  objectiveText: 'Ship the objective watcher',
  tier: 'standard',
  landingBar: 'files-on-disk',
  lanesEnabled: true,
  maxConcurrency: 8,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: { implementer: 'claude' },
  roleLaunch: { implementer: { effort: 'high' } },
  sitterOverrides: { updateBranch: 'on' },
  gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
}

describe('adaptObjectiveEnrollmentToCapabilities', () => {
  it('preserves the complete enrollment for a host that advertises both capabilities', () => {
    expect(
      adaptObjectiveEnrollmentToCapabilities(payload, [
        HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
        HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY
      ])
    ).toEqual(payload)
  })

  it('removes role launch alone when the host lacks that capability', () => {
    const adapted = adaptObjectiveEnrollmentToCapabilities(payload, [
      HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
    ])

    expect(adapted).not.toHaveProperty('roleLaunch')
    expect(adapted).toMatchObject({ lanesEnabled: true, maxConcurrency: 8, gates: payload.gates })
  })

  it('removes parallel-only fields and clamps concurrency when the host lacks parallel execution', () => {
    const adapted = adaptObjectiveEnrollmentToCapabilities(payload, [
      HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY
    ])

    expect(adapted).not.toHaveProperty('lanesEnabled')
    expect(adapted).not.toHaveProperty('gates')
    expect(adapted).toMatchObject({ maxConcurrency: 1, roleLaunch: payload.roleLaunch })
  })

  it('adapts both feature groups for a host that advertises neither capability', () => {
    const adapted = adaptObjectiveEnrollmentToCapabilities(payload, [])

    expect(adapted).not.toHaveProperty('lanesEnabled')
    expect(adapted).not.toHaveProperty('gates')
    expect(adapted).not.toHaveProperty('roleLaunch')
    expect(adapted.maxConcurrency).toBe(1)
  })
})
