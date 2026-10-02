import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  projectHeimdallDetailParkReasonForClient,
  projectHeimdallFleetSnapshotForClient,
  projectWatcherListEntryForClient
} from '../../../../src/main/runtime/rpc/methods/fork-heimdall/park-reason-wire'
import { HEIMDALL_METHODS } from '../../../../src/main/runtime/rpc/methods/fork-heimdall/heimdall'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
} from '../../../../src/shared/fork-heimdall/capability'
import {
  NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  RUNTIME_CAPABILITIES
} from '../../../../src/shared/protocol-version'
import {
  EnrollSuccessSchema,
  HeimdallSubscriptionEventSchema
} from '../../../../src/shared/fork-heimdall/api'
import {
  HeimdallFleetSnapshotSchema,
  WatcherCommandResultSchema,
  WatcherDetailSchema,
  type HeimdallFleetSnapshot,
  type WatcherFleetEntry
} from '../../../../src/shared/fork-heimdall/fleet-types'
import {
  EnrollSuccessReaderSchema,
  HeimdallFleetSnapshotReaderSchema,
  HeimdallSubscriptionEventReaderSchema,
  WatcherCommandResultReaderSchema,
  WatcherDetailReaderSchema
} from '../../../../src/shared/fork-heimdall/remote-reader-schemas'
import type { EnrollInput, WatcherKindId } from '../../../../src/shared/fork-heimdall/watcher-types'
import { enrollmentForPipelineCompatibility } from '../../../../src/main/fork-heimdall/fleet-remote-enrollment-capabilities'
import { BUILTIN_OBJECTIVE_PIPELINE_TEXT } from '../../../../src/shared/fork-heimdall-pipeline/builtin-pipelines'
import { ObjectiveDetailSchema } from '../../../../src/shared/fork-heimdall-objective/detail-types'
import { ObjectiveDetailReaderSchema } from '../../../../src/main/runtime/rpc/methods/fork-heimdall-objective/objective-detail-reader-schema'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from '../release-checkout'

const SUITE_TIMEOUT_MS = 180_000
let baselineMethodNames: string[]
let baselineCapabilities: string[]
let baselineClientCapabilities: string[]
let baselineFleetSnapshotSchema: z.ZodType
let baselineEnrollInputSchema: z.ZodType
let baselineWatcherStatusSchema: z.ZodType

const enrollmentWithExtraKeys = {
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
  commandRevision: 2,
  capabilities: { land: 'gated' },
  budget: { wallClockActiveMs: 60_000, turns: 4, hostBudgetField: true },
  kindPayload: { hostPayloadField: { retained: true } },
  coordinatorIdentity: {
    handle: 'coordinator-1',
    paneKey: 'pane-1',
    hostCoordinatorField: true
  },
  orchestrationRunId: null,
  createdAtMs: 1,
  terminalAtMs: null,
  hostEnrollmentField: true
} as const

const listEntryWithExtraKeys = {
  name: 'Objective watcher',
  enrollment: enrollmentWithExtraKeys,
  status: {
    watcherId: 'watcher-1',
    enabled: true,
    state: 'watching',
    phase: 'observe',
    reason: null,
    parkReason: null,
    budget: { activeMs: 100, turns: 1, exhausted: null, hostBudgetStateField: true },
    startedAtMs: 1,
    lastSuccessfulTickAtMs: 10,
    nextPulseAtMs: 20,
    hostStatusField: true
  },
  hostListEntryField: true
} as const

const fleetEntryWithExtraKeys = {
  target: {
    watcherId: 'watcher-1',
    connectionId: null,
    pairingRevision: null,
    hostTargetField: true
  },
  entry: listEntryWithExtraKeys,
  ownerFence: {
    executionHostId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceKey: 'local::/repo',
    revision: 2,
    hostFenceField: true
  },
  observedAtMs: 20,
  contact: 'live',
  readOnlyReason: null,
  capabilityNotes: [],
  paused: false,
  hostFleetEntryField: true
} as const

const watcherDetailWithExtraKeys = {
  watcher: fleetEntryWithExtraKeys,
  ledger: {
    watcherId: 'watcher-1',
    entries: [
      {
        kind: 'attempt',
        eventId: 'attempt-event-1',
        watcherId: 'watcher-1',
        atMs: 11,
        origin: 'owner',
        class: 'fact',
        attemptId: 'attempt-1',
        fingerprint: 'fingerprint-1',
        action: {
          kind: 'future-action',
          capability: 'land',
          visibility: 'local',
          contentIdentity: 'content-1',
          evidenceKey: 'evidence-1',
          hostActionField: { retained: true }
        },
        state: 'settled',
        effect: 'landed',
        result: { hostResultField: { retained: true } },
        hostLedgerEntryField: true
      },
      {
        kind: 'evidence',
        eventId: 'evidence-event-1',
        watcherId: 'watcher-1',
        atMs: 12,
        origin: 'owner',
        class: 'fact',
        evidenceKind: 'future-evidence',
        payload: { hostEvidenceField: { retained: true } },
        hostLedgerEntryField: true
      }
    ],
    hostLedgerField: true
  },
  traces: [],
  workers: [
    {
      dispatchId: 'dispatch-1',
      task: 'Implement the objective',
      dispatchedAtMs: 2,
      lastContactAtMs: 10,
      liveness: 'live',
      reason: null,
      question: {
        messageId: 'message-1',
        body: 'Continue?',
        hostQuestionField: true
      },
      hostWorkerField: true
    }
  ],
  hostDetailField: true
} as const

const objectiveDetailWithExtraKeys = {
  contract: {
    objectiveText: 'Implement the objective',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritory: ['src/**'],
    roleAgents: { hostRoleAgentField: 'future-agent' },
    sitterOverrides: { hostOverrideField: 'gated' },
    hostContractField: true
  },
  revisions: [],
  nodes: [],
  verdicts: [],
  landing: [],
  planLint: {
    findings: [],
    truncated: false,
    conflictPairs: [],
    criticalPathLength: 0,
    maxWidth: 0,
    hostPlanLintField: true
  },
  assumptions: [{ claim: 'The API is stable', dependentTaskKeys: [], hostAssumptionField: true }],
  planReviews: [
    {
      targetKind: 'revision',
      targetId: 'revision-1',
      round: 1,
      verdict: 'approve',
      summary: 'Looks solid',
      createdAtMs: 1,
      hostPlanReviewField: true
    }
  ],
  pendingPatch: {
    id: 'patch-1',
    status: 'pending',
    rejection: null,
    touchedTaskKeys: [],
    hostPendingPatchField: true
  },
  gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600, hostGateField: true }],
  asOfMs: 20,
  hostObjectiveDetailField: true
} as const

const remoteReaderFixtures = [
  {
    name: 'watcher detail',
    reader: WatcherDetailReaderSchema,
    writer: WatcherDetailSchema,
    payload: watcherDetailWithExtraKeys,
    malformed: {
      ...watcherDetailWithExtraKeys,
      watcher: { ...fleetEntryWithExtraKeys, contact: 'lost' }
    },
    strippedPaths: ['hostDetailField', 'watcher.entry.enrollment.hostEnrollmentField']
  },
  {
    name: 'enroll success',
    reader: EnrollSuccessReaderSchema,
    writer: EnrollSuccessSchema,
    payload: {
      status: 'enrolled',
      entry: listEntryWithExtraKeys,
      hostEnrollResultField: true
    },
    malformed: { status: 'future-status', entry: listEntryWithExtraKeys },
    strippedPaths: ['hostEnrollResultField', 'entry.enrollment.hostEnrollmentField']
  },
  {
    name: 'command result',
    reader: WatcherCommandResultReaderSchema,
    writer: WatcherCommandResultSchema,
    payload: { status: 'applied', appliedAtMs: 20, hostCommandResultField: true },
    malformed: { status: 'future-status', appliedAtMs: 20 },
    strippedPaths: ['hostCommandResultField']
  },
  {
    name: 'subscription event',
    reader: HeimdallSubscriptionEventReaderSchema,
    writer: HeimdallSubscriptionEventSchema,
    payload: {
      type: 'snapshot',
      snapshot: {
        entries: [fleetEntryWithExtraKeys],
        generatedAtMs: 20,
        hostSnapshotField: true
      },
      hostSubscriptionField: true
    },
    malformed: { type: 'future-event', snapshot: { entries: [], generatedAtMs: 20 } },
    strippedPaths: ['hostSubscriptionField', 'snapshot.hostSnapshotField']
  },
  {
    name: 'objective detail',
    reader: ObjectiveDetailReaderSchema,
    writer: ObjectiveDetailSchema,
    payload: objectiveDetailWithExtraKeys,
    malformed: {
      ...objectiveDetailWithExtraKeys,
      contract: { ...objectiveDetailWithExtraKeys.contract, tier: 'future-tier' }
    },
    strippedPaths: [
      'hostObjectiveDetailField',
      'contract.hostContractField',
      'planLint.hostPlanLintField',
      'assumptions.0.hostAssumptionField',
      'planReviews.0.hostPlanReviewField',
      'pendingPatch.hostPendingPatchField',
      'gates.0.hostGateField'
    ]
  }
] as const

function methodNames(methods: unknown): string[] {
  if (!Array.isArray(methods)) {
    throw new Error('Cross-version Heimdall harness found no RPC method registry')
  }
  return methods.flatMap((method) => {
    if (!method || typeof method !== 'object') {
      return []
    }
    return 'name' in method && typeof method.name === 'string' ? [method.name] : []
  })
}
function releaseZodSchema(module: Record<string, unknown>, name: string): z.ZodType {
  const schema = module[name]
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`Cross-version baseline did not export ${name}`)
  }
  return schema
}

function watcherFleetEntry(kind: WatcherKindId): WatcherFleetEntry {
  const watcherId = `watcher-${kind}`
  return {
    target: { watcherId, connectionId: null, pairingRevision: null },
    entry: {
      name: `${kind} watcher`,
      enrollment: {
        watcherId,
        kind,
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
        watcherId,
        enabled: true,
        state: 'watching',
        phase: 'observe',
        reason: null,
        parkReason: null,
        budget: { activeMs: 0, turns: 0, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: null,
        nextPulseAtMs: null
      }
    },
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
    paused: false,
    workflowPhase: 'observe'
  }
}

function pipelineWireSnapshot(): HeimdallFleetSnapshot {
  return {
    entries: [watcherFleetEntry('objective'), watcherFleetEntry('pipeline')],
    generatedAtMs: 20
  }
}

beforeAll(async () => {
  const baseline = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [registry, protocol, fleetTypes, watcherTypes] = await Promise.all([
    importReleaseCheckoutModule(baseline, '/src/main/runtime/rpc/methods/index.ts'),
    importReleaseCheckoutModule(baseline, '/src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(baseline, '/src/shared/fork-heimdall/fleet-types.ts'),
    importReleaseCheckoutModule(baseline, '/src/shared/fork-heimdall/watcher-types.ts')
  ])
  baselineMethodNames = methodNames(registry.ALL_RPC_METHODS)
  baselineCapabilities = Array.isArray(protocol.RUNTIME_CAPABILITIES)
    ? protocol.RUNTIME_CAPABILITIES
    : []
  baselineClientCapabilities = Array.isArray(protocol.NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
    ? protocol.NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    : []
  baselineFleetSnapshotSchema = releaseZodSchema(fleetTypes, 'HeimdallFleetSnapshotSchema')
  baselineEnrollInputSchema = releaseZodSchema(watcherTypes, 'EnrollInputSchema')
  baselineWatcherStatusSchema = releaseZodSchema(watcherTypes, 'WatcherStatusSchema')
}, SUITE_TIMEOUT_MS)

describe('Heimdall remote reader compatibility', () => {
  it.each(remoteReaderFixtures)(
    '$name strips additive keys without weakening its strict writer',
    ({ reader, writer, payload, strippedPaths }) => {
      const parsed = reader.safeParse(payload)
      expect(parsed.success).toBe(true)
      expect(writer.safeParse(payload).success).toBe(false)
      if (parsed.success) {
        for (const path of strippedPaths) {
          expect(parsed.data).not.toHaveProperty(path)
        }
      }
    }
  )

  it.each(remoteReaderFixtures)(
    '$name still rejects malformed known fields and discriminators',
    ({ reader, malformed }) => {
      expect(reader.safeParse(malformed).success).toBe(false)
    }
  )

  it('preserves opaque and passthrough payload fields', () => {
    const detail = WatcherDetailReaderSchema.parse(watcherDetailWithExtraKeys)
    expect(detail.watcher.entry.enrollment.kindPayload).toEqual({
      hostPayloadField: { retained: true }
    })
    expect(detail.ledger.entries).toMatchObject([
      {
        action: { hostActionField: { retained: true } },
        result: { hostResultField: { retained: true } }
      },
      { payload: { hostEvidenceField: { retained: true } } }
    ])
  })
  it('reads future watcher kinds as unknown while preserving fleet rows and evidence', () => {
    const knownDetail = WatcherDetailReaderSchema.parse(watcherDetailWithExtraKeys)
    const futureDetail = {
      ...knownDetail,
      watcher: {
        ...knownDetail.watcher,
        entry: {
          ...knownDetail.watcher.entry,
          enrollment: { ...knownDetail.watcher.entry.enrollment, kind: 'future-engine-kind' }
        }
      }
    }
    const detail = WatcherDetailReaderSchema.safeParse(futureDetail)
    const fleet = HeimdallFleetSnapshotReaderSchema.safeParse({
      entries: [futureDetail.watcher],
      generatedAtMs: 20
    })

    expect(WatcherDetailSchema.safeParse(futureDetail).success).toBe(false)
    expect(detail.success).toBe(true)
    expect(fleet.success).toBe(true)
    if (detail.success) {
      expect(detail.data.watcher.entry.enrollment.kind).toBe('unknown')
      expect(detail.data.ledger.entries).toHaveLength(2)
      expect(detail.data.ledger.entries).toMatchObject([
        {
          action: { hostActionField: { retained: true } },
          result: { hostResultField: { retained: true } }
        },
        { payload: { hostEvidenceField: { retained: true } } }
      ])
      expect(() =>
        projectHeimdallDetailParkReasonForClient(detail.data, {
          clientKind: 'runtime',
          clientCapabilities: baselineClientCapabilities
        })
      ).toThrow('watcher-not-found')
    }
    if (fleet.success) {
      expect(fleet.data.entries[0]?.entry.enrollment.kind).toBe('unknown')
      const baselineProjection = projectHeimdallFleetSnapshotForClient(fleet.data, {
        clientKind: 'runtime',
        clientCapabilities: baselineClientCapabilities
      })
      expect(baselineProjection.entries).toEqual([])
      expect(baselineFleetSnapshotSchema.safeParse(baselineProjection).success).toBe(true)
    }
    const subscription = HeimdallSubscriptionEventReaderSchema.safeParse({
      type: 'snapshot',
      snapshot: { entries: [futureDetail.watcher], generatedAtMs: 20 }
    })
    expect(subscription.success).toBe(true)
    if (subscription.success && subscription.data.type === 'snapshot') {
      expect(subscription.data.snapshot.entries[0]?.entry.enrollment.kind).toBe('unknown')
    }
    expect(
      WatcherDetailReaderSchema.safeParse({
        ...futureDetail,
        watcher: {
          ...futureDetail.watcher,
          entry: {
            ...futureDetail.watcher.entry,
            enrollment: {
              ...futureDetail.watcher.entry.enrollment,
              workspaceKey: 'ssh:buildbox::/repo'
            }
          }
        }
      }).success
    ).toBe(false)
    expect(
      WatcherDetailReaderSchema.safeParse({
        ...futureDetail,
        watcher: {
          ...futureDetail.watcher,
          entry: {
            ...futureDetail.watcher.entry,
            enrollment: { ...futureDetail.watcher.entry.enrollment, kind: 42 }
          }
        }
      }).success
    ).toBe(false)
  })
})

describe('Heimdall cross-version wire registration', () => {
  it('keeps every Heimdall method published by the moving release baseline', () => {
    const baselineHeimdall = baselineMethodNames.filter((name) => name.startsWith('heimdall:'))
    expect(baselineHeimdall.length).toBeGreaterThan(0)
    expect(methodNames(HEIMDALL_METHODS)).toEqual(expect.arrayContaining(baselineHeimdall))
  })

  it('keeps command capability advertisement aligned with method registration in both builds', () => {
    expect(baselineMethodNames.includes('heimdall:command')).toBe(
      baselineCapabilities.includes(HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
    )
    expect(methodNames(HEIMDALL_METHODS)).toContain('heimdall:command')
    expect(RUNTIME_CAPABILITIES).toContain(HEIMDALL_COMMANDS_RUNTIME_CAPABILITY)
  })

  it('advertises new objective worktree creation on capable hosts', () => {
    expect(RUNTIME_CAPABILITIES).toContain(HEIMDALL_OBJECTIVE_NEW_WORKTREE_RUNTIME_CAPABILITY)
  })
})
describe('Heimdall pipeline fleet wire compatibility with the release baseline', () => {
  it('filters a pipeline row so the actual baseline fleet schema can parse the host reply', () => {
    const snapshot = pipelineWireSnapshot()
    expect(baselineFleetSnapshotSchema.safeParse(snapshot).success).toBe(false)

    const projected = projectHeimdallFleetSnapshotForClient(snapshot, {
      clientKind: 'runtime',
      clientCapabilities: baselineClientCapabilities
    })

    expect(projected.entries.map((entry) => entry.entry.enrollment.kind)).toEqual(['objective'])
    expect(baselineFleetSnapshotSchema.safeParse(projected).success).toBe(true)
  })

  it('shows pipeline rows to the current native client', () => {
    const projected = projectHeimdallFleetSnapshotForClient(pipelineWireSnapshot(), {
      clientKind: 'runtime',
      clientCapabilities: [...NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES]
    })

    expect(projected.entries.map((entry) => entry.entry.enrollment.kind)).toEqual([
      'objective',
      'pipeline'
    ])
    expect(HeimdallFleetSnapshotSchema.safeParse(projected).success).toBe(true)
  })

  it('strips a pin before the actual baseline strict enrollment schema sees it', () => {
    const input: EnrollInput = {
      kind: 'objective',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: {},
      pipelinePin: {
        ref: 'builtin:objective',
        scope: 'builtin',
        id: 'objective',
        contentHash: `sha256:${'0'.repeat(64)}`,
        documentVersion: 1
      }
    }
    const compatible = enrollmentForPipelineCompatibility(input, {
      pipelineSupport: 'unsupported',
      pipelineNodeTypes: new Set<never>()
    })

    expect(baselineEnrollInputSchema.safeParse(input).success).toBe(false)
    expect(baselineEnrollInputSchema.safeParse(compatible).success).toBe(true)
    expect(compatible.kindPayload).toEqual(input.kindPayload)
  })
  it('refuses a source-bearing custom pin instead of stripping it for the baseline host', () => {
    const input: EnrollInput = {
      kind: 'objective',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: {},
      pipelinePin: {
        ref: 'repo:objective',
        scope: 'repo',
        id: 'objective',
        contentHash: `sha256:${'0'.repeat(64)}`,
        documentVersion: 1
      },
      pipelineSource: { sourceText: BUILTIN_OBJECTIVE_PIPELINE_TEXT }
    }

    expect(baselineEnrollInputSchema.safeParse(input).success).toBe(false)
    expect(() =>
      enrollmentForPipelineCompatibility(input, {
        pipelineSupport: 'unsupported',
        pipelineNodeTypes: new Set<never>()
      })
    ).toThrow(
      'The owning runtime does not support Heimdall pipelines. Update the host and try again.'
    )
  })
})

describe('Heimdall baseline park reason compatibility', () => {
  it('publishes typed park reasons to the actual baseline client', () => {
    const entry = watcherFleetEntry('objective').entry
    entry.status.parkReason = {
      kind: 'worker-escalation',
      escalationId: 'escalation-1',
      messageId: 'message-1'
    }

    const projected = projectWatcherListEntryForClient(entry, {
      clientKind: 'runtime',
      clientCapabilities: baselineClientCapabilities
    })

    expect(projected.status.parkReason).toEqual(entry.status.parkReason)
    expect(baselineWatcherStatusSchema.safeParse(projected.status).success).toBe(true)
  })

  it('degrades the typed reason for a baseline reader with the park reason capability removed', () => {
    const entry = watcherFleetEntry('objective').entry
    entry.status.parkReason = {
      kind: 'worker-escalation',
      escalationId: 'escalation-1',
      messageId: 'message-1'
    }

    const projected = projectWatcherListEntryForClient(entry, {
      clientKind: 'runtime',
      clientCapabilities: baselineClientCapabilities.filter(
        (capability) => capability !== HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
      )
    })

    expect(projected.status.parkReason).toBeNull()
    expect(baselineWatcherStatusSchema.safeParse(projected.status).success).toBe(true)
  })
})
