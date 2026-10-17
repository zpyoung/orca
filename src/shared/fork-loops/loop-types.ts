import { z } from 'zod'
import { isTuiAgent } from '../tui-agent-config'
import type { RuntimeTerminalWait } from '../runtime-terminal-contracts'
import type { TuiAgent } from '../tui-agent'

export const LOOP_NO_PROGRESS_ITERATIONS = 3
export const LOOP_RECENT_ITERATIONS_LIMIT = 50

const TimestampMsSchema = z.number().int().nonnegative()

export const LoopPresetSchema = z.enum(['until-done', 'interval', 'queue'])
export type LoopPreset = z.infer<typeof LoopPresetSchema>

export const LoopSessionPolicySchema = z.enum(['fresh', 'continue'])
export type LoopSessionPolicy = z.infer<typeof LoopSessionPolicySchema>

export function defaultSessionPolicyForPreset(preset: LoopPreset): LoopSessionPolicy {
  return preset === 'until-done' ? 'fresh' : 'continue'
}

export const LoopPromptSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('repeat'), body: z.string() }).strict(),
  z.object({ kind: z.literal('queue'), repeatQueue: z.boolean() }).strict()
])
export type LoopPromptSource = z.infer<typeof LoopPromptSourceSchema>

export const LoopPacingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('on-idle') }).strict(),
  z
    .object({
      kind: z.literal('interval'),
      minutes: z.number().int().min(1),
      anchor: z.enum(['from-end', 'wall-clock'])
    })
    .strict()
])
export type LoopPacing = z.infer<typeof LoopPacingSchema>

export const LoopDoneSchema = z
  .object({
    check: z
      .object({
        command: z.string(),
        timeoutSeconds: z.number().int().min(1).max(600),
        runWhen: z.enum(['every-iteration', 'on-claim'])
      })
      .strict()
      .optional(),
    evaluator: z.object({ condition: z.string() }).strict().optional()
  })
  .strict()
export type LoopDone = z.infer<typeof LoopDoneSchema>

export const LoopCapsSchema = z
  .object({
    maxIterations: z.number().int().min(1).optional(),
    maxActiveMinutes: z.number().int().min(1).optional(),
    maxCostUsd: z.number().positive().optional()
  })
  .strict()
export type LoopCaps = z.infer<typeof LoopCapsSchema>

export const LoopConfigSchema = z
  .object({
    promptSource: LoopPromptSourceSchema,
    pacing: LoopPacingSchema,
    sessionPolicy: LoopSessionPolicySchema,
    done: LoopDoneSchema,
    caps: LoopCapsSchema,
    noProgress: z.boolean(),
    protectedPaths: z.array(z.string()).optional(),
    checkpointCommits: z.boolean(),
    askBeforeNext: z.boolean(),
    resumeAtLimitReset: z.boolean()
  })
  .strict()
export type LoopConfig = z.infer<typeof LoopConfigSchema>

export const PauseReasonSchema = z.enum([
  'user',
  'cap-iterations',
  'cap-time',
  'cap-cost',
  'no-progress',
  'protected-path',
  'agent-blocked',
  'agent-decide',
  'crashed',
  'usage-limit',
  'interrupted-by-restart',
  'unverifiable',
  'ask-before-next',
  'queue-exhausted'
])
export type PauseReason = z.infer<typeof PauseReasonSchema>

export const LoopStateSchema = z.enum(['running', 'needs-you', 'paused', 'completed', 'stopped'])
export type LoopState = z.infer<typeof LoopStateSchema>

export const IterationEndReasonSchema = z.enum(['settled', 'crashed', 'interrupted', 'stopped'])
export type IterationEndReason = z.infer<typeof IterationEndReasonSchema>

export const IterationPhaseSchema = z.enum([
  'relaunching',
  'sending',
  'working',
  'needs-you',
  'checking',
  'evaluating',
  'waiting'
])
export type IterationPhase = z.infer<typeof IterationPhaseSchema>

export const IterationSummarySchema = z
  .object({
    n: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    startedAt: TimestampMsSchema,
    endedAt: TimestampMsSchema.nullable(),
    endReason: IterationEndReasonSchema.nullable(),
    checkPass: z.boolean().nullable(),
    evaluatorVerdict: z.enum(['met', 'not-met']).nullable(),
    added: z.number().int().nonnegative().nullable(),
    removed: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nullable()
  })
  .strict()
export type IterationSummary = z.infer<typeof IterationSummarySchema>

export const LoopSnapshotSchema = z
  .object({
    id: z.string().min(1),
    worktreeId: z.string().min(1),
    name: z.string(),
    agent: z.string().refine(isTuiAgent),
    preset: LoopPresetSchema,
    config: LoopConfigSchema,
    state: LoopStateSchema,
    pauseReason: PauseReasonSchema.optional(),
    pauseDetail: z.string().optional(),
    tab: z.object({ tabId: z.string(), paneKey: z.string() }).strict().optional(),
    iterationsCompleted: z.number().int().nonnegative(),
    currentIteration: z
      .object({
        n: z.number().int().nonnegative(),
        startedAt: TimestampMsSchema,
        phase: IterationPhaseSchema
      })
      .strict()
      .optional(),
    detached: z.boolean(),
    skippedTicks: z.number().int().nonnegative(),
    activeMs: z.number().nonnegative(),
    costUsd: z.number().optional(),
    nextIterationAt: TimestampMsSchema.optional(),
    pendingQuestion: z
      .object({ kind: z.enum(['blocked', 'decide']), text: z.string() })
      .strict()
      .optional(),
    recentIterations: z.array(IterationSummarySchema).max(LOOP_RECENT_ITERATIONS_LIMIT),
    warnings: z.array(z.string()).optional()
  })
  .strict()
export type LoopSnapshot = Omit<z.infer<typeof LoopSnapshotSchema>, 'agent'> & { agent: TuiAgent }

export const LoopWorktreeSummarySchema = z
  .object({
    loopCount: z.number().int().nonnegative(),
    primary: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        state: LoopStateSchema,
        pauseReason: PauseReasonSchema.optional(),
        iterationsCompleted: z.number().int().nonnegative(),
        maxIterations: z.number().int().min(1).optional()
      })
      .strict()
  })
  .strict()
export type LoopWorktreeSummary = z.infer<typeof LoopWorktreeSummarySchema>

export const LoopLaunchOverridesSchema = z
  .object({
    agentArgs: z.string().optional(),
    model: z.string().optional(),
    optionValues: z.record(z.string(), z.union([z.string(), z.boolean()])).optional()
  })
  .strict()

export const LoopCreateInputSchema = z
  .object({
    worktreeId: z.string().min(1),
    name: z.string().min(1),
    agent: z.string().refine(isTuiAgent),
    preset: LoopPresetSchema,
    config: LoopConfigSchema,
    launchOverrides: LoopLaunchOverridesSchema.optional()
  })
  .strict()
export type LoopCreateInput = Omit<z.infer<typeof LoopCreateInputSchema>, 'agent'> & {
  agent: TuiAgent
}

export const LoopErrorCodeSchema = z.enum([
  'loop_not_found',
  'loop_invalid_transition',
  'loop_runtime_unavailable',
  'loop_check_unsupported_host',
  'loop_evaluator_unavailable',
  'loop_store_read_only'
])
export type LoopErrorCode = z.infer<typeof LoopErrorCodeSchema>

export const CheckOutcomeSchema = z
  .object({
    ran: z.boolean(),
    pass: z.boolean(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    stdoutTail: z.string(),
    stderrTail: z.string(),
    durationMs: z.number().nonnegative(),
    error: z.string().optional()
  })
  .strict()
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>

export const EvaluatorVerdictSchema = z
  .object({ verdict: z.enum(['met', 'not-met']), reason: z.string() })
  .strict()
export type EvaluatorVerdict = z.infer<typeof EvaluatorVerdictSchema>

export const TreeSnapshotSchema = z
  .object({ treeId: z.string(), headSha: z.string().nullable() })
  .strict()
export type TreeSnapshot = z.infer<typeof TreeSnapshotSchema>

export const DiffStatsSchema = z
  .object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    files: z.array(z.string())
  })
  .strict()
export type DiffStats = z.infer<typeof DiffStatsSchema>

export const UsageTotalsSchema = z
  .object({
    providerSessionId: z.string(),
    costUsd: z.number().nullable(),
    totalTokens: z.number().nonnegative()
  })
  .strict()
export type UsageTotals = z.infer<typeof UsageTotalsSchema>

export const ParsedMarkerSchema = z
  .object({ kind: z.enum(['done', 'blocked', 'decide']), text: z.string().optional() })
  .strict()
export type ParsedMarker = z.infer<typeof ParsedMarkerSchema>

export const IterationRecordSchema = z
  .object({
    n: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    startedAt: TimestampMsSchema,
    endedAt: TimestampMsSchema,
    endReason: IterationEndReasonSchema,
    check: CheckOutcomeSchema.nullable(),
    evaluator: EvaluatorVerdictSchema.nullable(),
    diff: DiffStatsSchema.nullable(),
    treeBefore: z.string().nullable(),
    treeAfter: z.string().nullable(),
    costUsd: z.number().nullable(),
    markers: z.array(ParsedMarkerSchema),
    protectedPathHits: z.array(z.string()),
    checkpointCommit: z.string().nullable()
  })
  .strict()
export type IterationRecord = z.infer<typeof IterationRecordSchema>

/** Mirrors the `kind` discriminant of the main-process observer's `IterationSettlement`. */
export type IterationSettlementKind = 'settled' | 'crashed' | 'unverifiable' | 'aborted'

export type IterationEvidence = IterationRecord & {
  settlement: IterationSettlementKind
  usageLimit: { provider: 'claude' | 'codex'; resetsAt: number | null } | null
}

export const LoopRuntimeStateSchema = z
  .object({
    state: LoopStateSchema,
    iterationsCompleted: z.number().int().nonnegative(),
    activeMs: z.number().nonnegative(),
    costUsd: z.number().nullable(),
    consecutiveCrashesThisIteration: z.number().int().nonnegative(),
    maxIterationsGranted: z.number().int().nullable(),
    lastIterationEndedAt: TimestampMsSchema.nullable(),
    nextWallClockTickAt: TimestampMsSchema.nullable()
  })
  .strict()
export type LoopRuntimeState = z.infer<typeof LoopRuntimeStateSchema>

export const HoldSignalsSchema = z
  .object({
    userPaused: z.boolean(),
    stopRequested: z.enum(['after-iteration', 'now']).nullable(),
    awaitingApproval: z.boolean(),
    connection: z.enum(['live', 'unverifiable']),
    userTyping: z.boolean()
  })
  .strict()
export type HoldSignals = z.infer<typeof HoldSignalsSchema>

export const WaitReasonSchema = z.enum([
  'pacing',
  'user-typing',
  'agent-busy',
  'unverifiable',
  'limit-reset'
])
export type WaitReason = z.infer<typeof WaitReasonSchema>

export type NeedsYouReason =
  | 'permission'
  | 'interactive-prompt'
  | 'blocked-state'
  | NonNullable<RuntimeTerminalWait['blockedReason']>

export const LoopEditPatchSchema = LoopConfigSchema.partial()
  .extend({ name: z.string().min(1).optional() })
  .strict()
export type LoopEditPatch = z.infer<typeof LoopEditPatchSchema>

export const QueueOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('add'),
      body: z.string(),
      position: z.number().int().nonnegative().optional()
    })
    .strict(),
  z.object({ op: z.literal('edit'), id: z.string().min(1), body: z.string() }).strict(),
  z
    .object({
      op: z.literal('move'),
      id: z.string().min(1),
      position: z.number().int().nonnegative()
    })
    .strict(),
  z.object({ op: z.literal('remove'), id: z.string().min(1) }).strict()
])
export type QueueOp = z.infer<typeof QueueOpSchema>
