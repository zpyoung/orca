import { z } from 'zod'
import {
  EffectCertaintySchema,
  ObjectiveFailureClassSchema,
  ReportValidationProvenanceSchema
} from './effect-certainty'

const IdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0)
const TimestampSchema = z.number().int().nonnegative()

export const KernelActionSchema = z
  .object({
    kind: IdSchema,
    capability: IdSchema,
    visibility: z.enum(['external', 'local']),
    contentIdentity: IdSchema,
    evidenceKey: IdSchema,
    recovery: z.literal('replay-safe').optional(),
    expectedState: z.object({ target: IdSchema, before: IdSchema }).strict().optional()
  })
  .passthrough()
export type KernelAction = z.infer<typeof KernelActionSchema>

export const ApprovalScopeSchema = z
  .object({
    actionKind: IdSchema,
    contentIdentity: IdSchema,
    evidenceKey: IdSchema,
    preparedCommitSha: IdSchema.optional()
  })
  .strict()
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>

export const LedgerOriginSchema = z.enum(['owner', 'client'])
export type LedgerOrigin = z.infer<typeof LedgerOriginSchema>

export const LedgerClassSchema = z.enum(['fact', 'observation'])
export type LedgerClass = z.infer<typeof LedgerClassSchema>

const OwnerFactBaseSchema = z.object({
  eventId: IdSchema,
  watcherId: IdSchema,
  atMs: TimestampSchema,
  origin: z.literal('owner'),
  class: z.literal('fact')
})

const OwnerObservationBaseSchema = z.object({
  eventId: IdSchema,
  watcherId: IdSchema,
  atMs: TimestampSchema,
  origin: z.literal('owner'),
  class: z.literal('observation')
})

export const AttemptEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('attempt'),
  attemptId: IdSchema,
  fingerprint: IdSchema,
  action: KernelActionSchema,
  state: z.enum(['attempted', 'running', 'settled']),
  effect: EffectCertaintySchema.optional(),
  result: z.unknown().optional(),
  reason: z.string().optional(),
  expectedBefore: z.string().optional(),
  expectedAfter: z.string().optional(),
  failureClass: ObjectiveFailureClassSchema.optional(),
  dispatch: z
    .object({
      // absent once a determinate settlement no longer needs the prompt recover() would replay
      spec: IdSchema.optional(),
      agent: IdSchema.optional(),
      taskKey: IdSchema.optional(),
      deps: z.array(IdSchema).optional(),
      workspaceId: IdSchema.optional(),
      reuseTerminal: IdSchema.optional(),
      dispatchKind: z.enum(['planner', 'child'])
    })
    .strict()
    .optional(),
  dispatchId: IdSchema.optional(),
  orchestrationRequestId: IdSchema.optional()
}).strict()
export type AttemptEntry = z.infer<typeof AttemptEntrySchema>

export const AttemptResolvedEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('attempt-resolved'),
  attemptId: IdSchema,
  effect: z.enum(['landed', 'not-landed']),
  failureClass: ObjectiveFailureClassSchema.optional(),
  reportValidation: ReportValidationProvenanceSchema.optional(),
  evidence: z.unknown()
}).strict()
export type AttemptResolvedEntry = z.infer<typeof AttemptResolvedEntrySchema>

export const AttemptAbandonedEntrySchema = OwnerObservationBaseSchema.extend({
  kind: z.literal('attempt-abandoned'),
  fingerprint: IdSchema,
  reason: z.enum(['workspace-moved', 'lease-refused', 'gate-hold']),
  detail: z.string().optional()
}).strict()
export type AttemptAbandonedEntry = z.infer<typeof AttemptAbandonedEntrySchema>

export const ApprovalEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('approval'),
  scope: ApprovalScopeSchema,
  decision: z.enum(['approved', 'rejected']),
  foldCount: z.number().int().positive()
}).strict()
export type ApprovalEntry = z.infer<typeof ApprovalEntrySchema>

/**
 * Escalations are revisions, not mutable rows. Revisions sharing an escalationId fold by
 * latest-wins query; foldCount is the cumulative count written on that new revision.
 */
export const EscalationEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('escalation'),
  escalationId: IdSchema,
  escalationKind: IdSchema,
  status: z.enum(['open', 'acknowledged', 'resolved', 'escalated']),
  foldCount: z.number().int().positive(),
  approvalScope: ApprovalScopeSchema.optional(),
  reason: z.string().optional()
}).strict()
export type EscalationEntry = z.infer<typeof EscalationEntrySchema>

export const OrchestrationEvidenceSourceSchema = z
  .object({
    kind: z.literal('orchestration'),
    sequence: z.number().int().nonnegative(),
    messageId: IdSchema,
    deliveryId: IdSchema.optional()
  })
  .strict()
export type OrchestrationEvidenceSource = z.infer<typeof OrchestrationEvidenceSourceSchema>

export const EvidenceEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('evidence'),
  evidenceKind: IdSchema,
  payload: z.unknown(),
  source: OrchestrationEvidenceSourceSchema.optional()
}).strict()
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>

export const IntervalOpenEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('interval-open'),
  intervalId: IdSchema,
  cause: z.enum(['action-in-flight', 'worker-dispatched', 'owner-in-flight'])
}).strict()
export type IntervalOpenEntry = z.infer<typeof IntervalOpenEntrySchema>

export const IntervalCheckpointEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('interval-checkpoint'),
  intervalId: IdSchema
}).strict()
export type IntervalCheckpointEntry = z.infer<typeof IntervalCheckpointEntrySchema>

export const IntervalCloseEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('interval-close'),
  intervalId: IdSchema,
  closeReason: z.enum(['settled', 'contact-lost', 'shutdown'])
}).strict()
export type IntervalCloseEntry = z.infer<typeof IntervalCloseEntrySchema>

export const TurnEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('turn'),
  dispatchKind: z.enum(['planner', 'child']),
  attemptId: IdSchema.optional(),
  dispatchId: IdSchema
}).strict()
export type TurnEntry = z.infer<typeof TurnEntrySchema>

export const ClientObservationEntrySchema = z
  .object({
    eventId: IdSchema,
    watcherId: IdSchema,
    atMs: TimestampSchema,
    origin: z.literal('client'),
    class: z.literal('observation'),
    kind: z.literal('client-observation'),
    what: IdSchema,
    detail: z.string().optional()
  })
  .strict()
export type ClientObservationEntry = z.infer<typeof ClientObservationEntrySchema>

export const TerminalEntrySchema = OwnerFactBaseSchema.extend({
  kind: z.literal('terminal'),
  state: IdSchema,
  reason: IdSchema
}).strict()
export type TerminalEntry = z.infer<typeof TerminalEntrySchema>

export const LedgerEntrySchema = z.discriminatedUnion('kind', [
  AttemptEntrySchema,
  AttemptResolvedEntrySchema,
  AttemptAbandonedEntrySchema,
  ApprovalEntrySchema,
  EscalationEntrySchema,
  EvidenceEntrySchema,
  IntervalOpenEntrySchema,
  IntervalCheckpointEntrySchema,
  IntervalCloseEntrySchema,
  TurnEntrySchema,
  ClientObservationEntrySchema,
  TerminalEntrySchema
])
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

export const WatcherLedgerSchema = z
  .object({
    watcherId: IdSchema,
    entries: z.array(LedgerEntrySchema).readonly()
  })
  .strict()
export type WatcherLedger = z.infer<typeof WatcherLedgerSchema>
