import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveGate } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import { deriveObjectiveFailureContext } from './dispatch-failure-context'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveGateAttempt } from './objective-store-gate-attempts'
import type { ObjectivePlanPatchRecord } from './objective-store-plan-patches'
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large WatcherEnrollment type; only watcherId is exercised.
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only getGateAttempt is exercised.
  return {
    getGateAttempt: (_watcherId: string, gateName: string) => attempts[gateName] ?? null
  } as unknown as ObjectiveStore
}

function planPatch(overrides: Partial<ObjectivePlanPatchRecord> = {}): ObjectivePlanPatchRecord {
  return {
    id: 'patch-1',
    watcherId: 'watcher-1',
    revisionId: 'revision-1',
    createdByDispatchId: 'repair-planner-1',
    repairOrdinal: 1,
    report: { repair: { upsertTasks: [], dropTaskKeys: [] } },
    digest: 'patch-digest-1',
    status: 'rejected',
    rejection: 'invalid-report:malformed json',
    createdAtMs: 10,
    resolvedAtMs: 20,
    ...overrides
  }
}

function storeWithPlanPatches(patches: ObjectivePlanPatchRecord[]): ObjectiveStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  return {
    getGateAttempt: () => null,
    listPlanPatches: (_watcherId: string) => patches
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

function runGateAction(
  gateName: string,
  contentIdentity = 'content-current'
): Extract<ObjectiveAction, { kind: 'run-gate' }> {
  return {
    kind: 'run-gate',
    capability: 'check',
    visibility: 'local',
    contentIdentity,
    evidenceKey: `objective-gate:${gateName}:${contentIdentity}`,
    gateName,
    command: 'pnpm test',
    timeoutSeconds: 900
  }
}

function notLandedGateAttemptLedger(
  gateName: string,
  contentIdentity = 'content-current'
): WatcherLedger {
  return {
    watcherId: 'watcher-1',
    entries: [
      {
        eventId: 'event-gate-attempt',
        watcherId: 'watcher-1',
        atMs: 1,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'attempt-gate-1',
        fingerprint: 'fingerprint-gate-1',
        action: runGateAction(gateName, contentIdentity),
        state: 'settled',
        effect: 'not-landed'
      }
    ]
  }
}

function inFlightGateAttemptLedger(
  gateName: string,
  contentIdentity = 'content-current'
): WatcherLedger {
  return {
    watcherId: 'watcher-1',
    entries: [
      {
        eventId: 'event-gate-attempt',
        watcherId: 'watcher-1',
        atMs: 1,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'attempt-gate-1',
        fingerprint: 'fingerprint-gate-1',
        action: runGateAction(gateName, contentIdentity),
        state: 'attempted'
      }
    ]
  }
}

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

  it('derives the gate name, command, and failure detail from a not-landed run-gate ledger attempt (E)', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate({ name: 'unit', command: 'pnpm test' })]),
      ledger: notLandedGateAttemptLedger('unit'),
      objectiveStore: storeWithGateAttempts({ unit: null }),
      activeRevisionId: undefined
    })

    expect(context).toEqual({
      gateFailure: {
        gateName: 'unit',
        command: 'pnpm test',
        exitCode: null,
        timedOut: false,
        stdoutTail: null,
        stderrTail: null,
        detail: 'the gate attempt itself failed to land'
      }
    })
  })

  it('prefers a completed failed gate-attempt row over a not-landed ledger attempt', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate({ name: 'unit' })]),
      ledger: notLandedGateAttemptLedger('unit'),
      objectiveStore: storeWithGateAttempts({ unit: gateAttempt() }),
      activeRevisionId: undefined
    })

    expect(context?.gateFailure).toMatchObject({ gateName: 'unit', exitCode: 1 })
    expect(context?.gateFailure).not.toHaveProperty('detail')
  })

  it('returns undefined for a still in-flight run-gate ledger attempt, not yet not-landed', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding([gate({ name: 'unit' })]),
      ledger: inFlightGateAttemptLedger('unit'),
      objectiveStore: storeWithGateAttempts({ unit: null }),
      activeRevisionId: undefined
    })

    expect(context).toBeUndefined()
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
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

describe('deriveObjectiveFailureContext previous repair rejection (C5)', () => {
  beforeEach(() => {
    readRoleReport.mockReset()
    readRoleReport.mockResolvedValue({ ok: false, reason: 'missing' })
  })

  it('carries the most recent rejected patch not caused by a plan-review revise', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding(undefined),
      ledger: emptyLedger,
      objectiveStore: storeWithPlanPatches([
        planPatch({ id: 'patch-1', repairOrdinal: 1, rejection: 'invalid-report:malformed json' }),
        planPatch({ id: 'patch-2', repairOrdinal: 2, rejection: 'changes-frozen-node:core' })
      ]),
      activeRevisionId: 'revision-1'
    })

    expect(context).toEqual({ previousRepairRejection: 'changes-frozen-node:core' })
  })

  it('omits a rejection caused by a plan-review revise, since that recovers findings elsewhere', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding(undefined),
      ledger: emptyLedger,
      objectiveStore: storeWithPlanPatches([
        planPatch({ id: 'patch-1', repairOrdinal: 1, rejection: 'plan-review-revise' })
      ]),
      activeRevisionId: 'revision-1'
    })

    expect(context).toBeUndefined()
  })

  it('ignores a rejected patch from a different revision', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding(undefined),
      ledger: emptyLedger,
      objectiveStore: storeWithPlanPatches([
        planPatch({ id: 'patch-1', revisionId: 'revision-other', rejection: 'invalid-report:x' })
      ]),
      activeRevisionId: 'revision-1'
    })

    expect(context).toBeUndefined()
  })

  it('returns undefined when there is no active revision to look up patches for', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding: binding(undefined),
      ledger: emptyLedger,
      objectiveStore: storeWithPlanPatches([planPatch()]),
      activeRevisionId: undefined
    })

    expect(context).toBeUndefined()
  })

  it('swallows a listPlanPatches failure instead of throwing', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
    const objectiveStore = {
      getGateAttempt: () => null,
      listPlanPatches: () => {
        throw new Error('database unavailable')
      }
    } as unknown as ObjectiveStore

    await expect(
      deriveObjectiveFailureContext({
        action: plannerReplanAfterFailure,
        binding: binding(undefined),
        ledger: emptyLedger,
        objectiveStore,
        activeRevisionId: 'revision-1'
      })
    ).resolves.toBeUndefined()
  })
})
