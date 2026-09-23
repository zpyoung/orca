import { z } from 'zod'
import { beforeAll, describe, expect, it } from 'vitest'
import { projectWatcherListEntryForClient } from '../../../../src/main/runtime/rpc/methods/fork-heimdall/park-reason-wire'
import { HEIMDALL_METHODS } from '../../../../src/main/runtime/rpc/methods/fork-heimdall/heimdall'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY
} from '../../../../src/shared/fork-heimdall/capability'
import { RUNTIME_CAPABILITIES } from '../../../../src/shared/protocol-version'
import {
  EnrollSuccessSchema,
  HeimdallSubscriptionEventSchema
} from '../../../../src/shared/fork-heimdall/api'
import {
  WatcherCommandResultSchema,
  WatcherDetailSchema
} from '../../../../src/shared/fork-heimdall/fleet-types'
import {
  EnrollSuccessReaderSchema,
  HeimdallSubscriptionEventReaderSchema,
  WatcherCommandResultReaderSchema,
  WatcherDetailReaderSchema,
  remoteReaderSchema
} from '../../../../src/shared/fork-heimdall/remote-reader-schemas'
import {
  WatcherParkReasonSchema,
  WatcherStatusSchema
} from '../../../../src/shared/fork-heimdall/watcher-types'
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
    const name = Reflect.get(method, 'name')
    return typeof name === 'string' ? [name] : []
  })
}

beforeAll(async () => {
  const baseline = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [registry, protocol] = await Promise.all([
    importReleaseCheckoutModule(baseline, '/src/main/runtime/rpc/methods/index.ts'),
    importReleaseCheckoutModule(baseline, '/src/shared/protocol-version.ts')
  ])
  baselineMethodNames = methodNames(registry.ALL_RPC_METHODS)
  baselineCapabilities = Array.isArray(protocol.RUNTIME_CAPABILITIES)
    ? (protocol.RUNTIME_CAPABILITIES as string[])
    : []
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
})

// No release tag carries fork-heimdall yet (the whole feature is unreleased), so there is no real
// prior build to check out for this one. A reader is rebuilt instead: the current WatcherParkReason
// union narrowed to the four kinds that predate this capability, run through the same
// remoteReaderSchema relaxation a real old client would compile. Adding a member later without
// gating it makes this ratchet fail, the same way it would have caught worker-escalation.
const BASELINE_PARK_REASON_KINDS = new Set([
  'budget',
  'stop-predicate',
  'worker-question',
  'coordinator-seat-lost'
])

function discriminatedUnionLiteralKind(option: z.ZodType): string {
  const shape = Reflect.get(option, 'shape') as Record<string, z.ZodType> | undefined
  const kindSchema = shape?.kind
  const values = kindSchema
    ? (Reflect.get(kindSchema, 'def') as { values?: unknown[] })?.values
    : undefined
  const value = values?.[0]
  if (typeof value !== 'string') {
    throw new Error('Heimdall park reason option has no literal "kind" discriminant')
  }
  return value
}

const baselineParkReasonOptions = WatcherParkReasonSchema.def.options.filter((option) =>
  BASELINE_PARK_REASON_KINDS.has(discriminatedUnionLiteralKind(option))
)
if (baselineParkReasonOptions.length !== BASELINE_PARK_REASON_KINDS.size) {
  throw new Error(
    'Heimdall baseline park reason fixture is missing a kind the current union still declares'
  )
}
const BaselineWatcherStatusSchema = z
  .object({
    ...WatcherStatusSchema.shape,
    parkReason: z
      .discriminatedUnion('kind', baselineParkReasonOptions as [z.ZodType, ...z.ZodType[]])
      .nullable()
  })
  .strict()
const BaselineWatcherStatusReaderSchema = remoteReaderSchema(BaselineWatcherStatusSchema)

const parkedWorkerEscalationEntry = {
  ...listEntryWithExtraKeys,
  status: {
    ...listEntryWithExtraKeys.status,
    parkReason: { kind: 'worker-escalation', escalationId: 'escalation-1', messageId: 'message-1' }
  }
} as const

describe('Heimdall watcher park reason capability gating', () => {
  it('would have failed an old reader on an undegraded worker-escalation park', () => {
    expect(
      BaselineWatcherStatusReaderSchema.safeParse(parkedWorkerEscalationEntry.status).success
    ).toBe(false)
  })

  it('lets an old reader parse the status the capability gate publishes when unnegotiated', () => {
    const degraded = projectWatcherListEntryForClient(parkedWorkerEscalationEntry, {
      clientKind: 'runtime',
      clientCapabilities: []
    })
    expect(degraded.status.parkReason).toBeNull()
    expect(BaselineWatcherStatusReaderSchema.safeParse(degraded.status).success).toBe(true)
  })

  it('publishes the typed value once the reader negotiates the capability', () => {
    const negotiated = projectWatcherListEntryForClient(parkedWorkerEscalationEntry, {
      clientKind: 'runtime',
      clientCapabilities: [HEIMDALL_WATCHER_PARK_REASON_V2_RUNTIME_CAPABILITY]
    })
    expect(negotiated.status.parkReason).toEqual(parkedWorkerEscalationEntry.status.parkReason)
  })
})
