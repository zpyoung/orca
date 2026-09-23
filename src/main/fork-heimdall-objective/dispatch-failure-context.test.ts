import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveGate } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import { deriveObjectiveFailureContext } from './dispatch-failure-context'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveGateAttempt } from './objective-store-gate-attempts'
import type { ObjectiveStore } from './objective-store'

const { readRoleReport } = vi.hoisted(() => ({ readRoleReport: vi.fn() }))
vi.mock('./report-ingestion', () => ({
  readObjectiveRoleReport: readRoleReport
}))

const gate = (overrides: Partial<ObjectiveGate> = {}): ObjectiveGate => ({
  name: 'unit',
  command: 'pnpm test',
  timeoutSeconds: 900,
  ...overrides
})

function binding(gates: ObjectiveGate[] | undefined): ObjectiveSnapshotBinding {
  return {
    enrollment: { watcherId: 'watcher-1' } as unknown as ObjectiveSnapshotBinding['enrollment'],
    contract: {
      objectiveText: 'Implement the objective.',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'folder',
      writeTerritory: ['src/**'],
      roleAgents: {},
      sitterOverrides: {},
      ...(gates === undefined ? {} : { gates })
    },
    target: {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/workspace',
      fileProvider: null
    }
  }
}

function gateAttempt(overrides: Partial<ObjectiveGateAttempt> = {}): ObjectiveGateAttempt {
  return {
    id: 'gate-attempt-1',
    watcherId: 'watcher-1',
    gateName: 'unit',
    contentIdentity: 'content-current',
    executionHostId: 'local',
    command: 'pnpm test',
    epoch: 1,
    startedAtMs: 1,
    exitCode: 1,
    timedOut: false,
    stdoutTail: 'running...',
    stderrTail: 'assertion failed',
    completedAtMs: 2,
    ...overrides
  }
}

function storeWithGateAttempts(
  attempts: Record<string, ObjectiveGateAttempt | null>
): ObjectiveStore {
  return {
    getGateAttempt: (_watcherId: string, gateName: string) => attempts[gateName] ?? null
  } as unknown as ObjectiveStore
}

const plannerReplanAfterFailure: Extract<ObjectiveAction, { kind: 'dispatch-planner' }> = {
  kind: 'dispatch-planner',
  capability: 'plan',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'plan:2',
  revisionNumber: 2,
  reason: 'replan-after-failure'
}

const emptyLedger: WatcherLedger = { watcherId: 'watcher-1', entries: [] }

describe('deriveObjectiveFailureContext gate failure', () => {
  beforeEach(() => {
    readRoleReport.mockReset()
    readRoleReport.mockResolvedValue({ ok: false, reason: 'missing' })
  })

  it('carries a failed gate attempt when no node failure is present', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate()]),
      ledger: emptyLedger,
      objectiveStore: storeWithGateAttempts({ unit: gateAttempt() }),
      activeRevisionId: undefined
    })

    expect(context).toEqual({
      gateFailure: {
        gateName: 'unit',
        command: 'pnpm test',
        exitCode: 1,
        timedOut: false,
        stdoutTail: 'running...',
        stderrTail: 'assertion failed'
      }
    })
  })

  it('treats a timed-out completed attempt as a failure even with exit code 0', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate()]),
      ledger: emptyLedger,
      objectiveStore: storeWithGateAttempts({
        unit: gateAttempt({ exitCode: 0, timedOut: true })
      }),
      activeRevisionId: undefined
    })

    expect(context?.gateFailure).toMatchObject({ gateName: 'unit', timedOut: true })
  })

  it('returns undefined when every declared gate passed', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate()]),
      ledger: emptyLedger,
      objectiveStore: storeWithGateAttempts({
        unit: gateAttempt({ exitCode: 0, timedOut: false })
      }),
      activeRevisionId: undefined
    })

    expect(context).toBeUndefined()
  })

  it('returns undefined when no gates are declared', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding(undefined),
      ledger: emptyLedger,
      objectiveStore: storeWithGateAttempts({}),
      activeRevisionId: undefined
    })

    expect(context).toBeUndefined()
  })

  it('picks the first failed gate in declaration order', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate({ name: 'unit' }), gate({ name: 'full-suite' })]),
      ledger: emptyLedger,
      objectiveStore: storeWithGateAttempts({
        unit: gateAttempt({ gateName: 'unit', exitCode: 0, timedOut: false }),
        'full-suite': gateAttempt({ gateName: 'full-suite', exitCode: 1 })
      }),
      activeRevisionId: undefined
    })

    expect(context?.gateFailure?.gateName).toBe('full-suite')
  })

  it('returns undefined for a reason other than replan-after-failure even with a failed gate', async () => {
    const context = await deriveObjectiveFailureContext({
      action: { ...plannerReplanAfterFailure, reason: 'replan-after-block' },
      binding: binding([gate()]),
      ledger: emptyLedger,
      objectiveStore: storeWithGateAttempts({ unit: gateAttempt() }),
      activeRevisionId: undefined
    })

    expect(context).toBeUndefined()
  })

  it('swallows a store lookup failure instead of throwing', async () => {
    const objectiveStore = {
      getGateAttempt: () => {
        throw new Error('database unavailable')
      }
    } as unknown as ObjectiveStore

    await expect(
      deriveObjectiveFailureContext({
        action: plannerReplanAfterFailure,
        binding: binding([gate()]),
        ledger: emptyLedger,
        objectiveStore,
        activeRevisionId: undefined
      })
    ).resolves.toBeUndefined()
  })
})
