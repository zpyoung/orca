import { z } from 'zod'
import { ApprovalScopeSchema } from '../fork-heimdall/ledger-types'

export const PipelineChoiceSchema = z.enum([
  'approve',
  'send-back',
  'abort',
  'retry',
  'skip',
  'extend',
  'accept',
  'one-more-round'
])
export type PipelineChoice = z.infer<typeof PipelineChoiceSchema>

export const PipelineChoiceCauseSchema = z.enum([
  'gate',
  'retries-exhausted',
  'time-limit',
  'merge-conflict',
  'loop-escalate',
  'loop-max',
  'swarm-lint',
  'configuration',
  'repeated-failure-after-own-fix'
])
export type PipelineChoiceCause = z.infer<typeof PipelineChoiceCauseSchema>

export const PipelineAnswerAttributionSchema = z
  .object({
    actor: z
      .object({
        user: z.string().min(1).max(128),
        host: z.string().min(1).max(255)
      })
      .strict(),
    surface: z.enum(['heimdall-detail', 'canvas-run', 'cli', 'owner-agent']),
    atMs: z.number().int().nonnegative()
  })
  .strict()
export type PipelineAnswerAttribution = z.infer<typeof PipelineAnswerAttributionSchema>

export const PipelineAnswerEvidenceSchema = z
  .object({
    approvalEventId: z.string().min(1),
    scope: ApprovalScopeSchema,
    choice: PipelineChoiceSchema,
    comment: z.string().min(1).max(4_000).optional(),
    extendMinutes: z.number().int().min(1).max(1_440).optional(),
    attribution: PipelineAnswerAttributionSchema,
    attemptId: z.string().min(1).optional(),
    attemptFingerprint: z.string().min(1).optional()
  })
  .strict()
  .refine(
    (evidence) =>
      (evidence.attemptId === undefined) === (evidence.attemptFingerprint === undefined),
    { message: 'Pipeline answer correlation fields must be supplied together' }
  )
  .refine(
    (evidence) =>
      evidence.attribution.surface !== 'owner-agent' ||
      (evidence.attemptId !== undefined && evidence.attemptFingerprint !== undefined),
    { message: 'Owner-agent pipeline answers require attempt correlation' }
  )
export type PipelineAnswerEvidence = z.infer<typeof PipelineAnswerEvidenceSchema>

export const PIPELINE_ANSWER_EVIDENCE_KIND = 'pipeline-answer' as const

const GATE_OPTIONS = ['approve', 'abort'] as const
const GATE_SEND_BACK_OPTIONS = ['approve', 'send-back', 'abort'] as const
const RETRY_OPTIONS = ['retry', 'skip', 'abort'] as const
const RETRY_SEND_BACK_OPTIONS = ['retry', 'skip', 'send-back', 'abort'] as const
const TIME_LIMIT_OPTIONS = ['extend', 'retry', 'skip', 'abort'] as const
const LOOP_OPTIONS = ['accept', 'one-more-round', 'abort'] as const
const RETRY_ABORT_OPTIONS = ['retry', 'abort'] as const

/** Returns the choices available for the node's current pipeline decision. */
export function pipelineChoiceOptions(input: {
  nodeType: string
  cause: PipelineChoiceCause
  gateSendBackTo?: string
  onFailSendBackTo?: string
}): readonly PipelineChoice[] {
  switch (input.cause) {
    case 'gate':
      return input.nodeType === 'gate' && input.gateSendBackTo !== undefined
        ? GATE_SEND_BACK_OPTIONS
        : GATE_OPTIONS
    case 'retries-exhausted':
      return input.onFailSendBackTo !== undefined ? RETRY_SEND_BACK_OPTIONS : RETRY_OPTIONS
    case 'time-limit':
      return TIME_LIMIT_OPTIONS
    case 'loop-escalate':
    case 'loop-max':
      return LOOP_OPTIONS
    case 'merge-conflict':
      return RETRY_OPTIONS
    case 'swarm-lint':
    case 'configuration':
    case 'repeated-failure-after-own-fix':
      return RETRY_ABORT_OPTIONS
  }
}

export type PipelineNodeEvidenceKeyParts = {
  instanceId: string
  epoch: number
  attempt: number
  cause?: PipelineChoiceCause
  deadlineMs?: number
  innerContentIdentity?: string
  innerEvidenceKey?: string
  step?: string
}

export type ParsedPipelineNodeEvidenceKey = {
  instanceId: string
  epoch: number
  attempt: number
  cause?: PipelineChoiceCause
  deadlineMs?: number
  innerContentIdentity?: string
  innerEvidenceKey?: string
  step?: string
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/** Encodes a node approval scope with a choice cause, native step, or composite evidence. */
export function makePipelineNodeEvidenceKey(parts: PipelineNodeEvidenceKeyParts): string {
  const segments: (string | number)[] = ['node', parts.instanceId, parts.epoch, parts.attempt]

  if (parts.step !== undefined) {
    if (parts.step.trim().length === 0) {
      throw new Error('A pipeline node evidence-key step cannot be empty')
    }
    if (
      parts.cause !== undefined ||
      parts.deadlineMs !== undefined ||
      parts.innerContentIdentity !== undefined ||
      parts.innerEvidenceKey !== undefined
    ) {
      throw new Error('A pipeline node evidence-key step cannot be combined with other qualifiers')
    }
    segments.push(`step:${parts.step}`)
  } else if (parts.cause !== undefined) {
    if (parts.innerContentIdentity !== undefined || parts.innerEvidenceKey !== undefined) {
      throw new Error(
        'A pipeline node evidence key cannot contain both a choice cause and inner evidence'
      )
    }
    if (parts.deadlineMs !== undefined && parts.cause !== 'time-limit') {
      throw new Error('Only a time-limit choice may include a deadline')
    }
    segments.push(`choice:${parts.cause}`)
    if (parts.deadlineMs !== undefined) {
      segments.push(parts.deadlineMs)
    }
  } else if (parts.deadlineMs !== undefined) {
    throw new Error('A pipeline node evidence key deadline requires a time-limit cause')
  } else if (parts.innerContentIdentity !== undefined || parts.innerEvidenceKey !== undefined) {
    if (parts.innerContentIdentity === undefined || parts.innerEvidenceKey === undefined) {
      throw new Error(
        'Composite pipeline node evidence requires both inner identity and evidence key'
      )
    }
    segments.push(parts.innerContentIdentity, parts.innerEvidenceKey)
  }

  return JSON.stringify(segments)
}

/** Decodes a node approval scope, returning null for malformed or non-node evidence keys. */
export function parsePipelineNodeEvidenceKey(
  evidenceKey: string
): ParsedPipelineNodeEvidenceKey | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(evidenceKey)
  } catch {
    return null
  }
  if (!Array.isArray(decoded)) {
    return null
  }

  const parts: readonly unknown[] = decoded
  const instanceId = parts[1]
  const epoch = parts[2]
  const attempt = parts[3]
  if (
    parts.length < 4 ||
    parts.length > 6 ||
    parts[0] !== 'node' ||
    !isNonEmptyString(instanceId) ||
    !isNonnegativeInteger(epoch) ||
    !isNonnegativeInteger(attempt)
  ) {
    return null
  }

  if (parts.length === 4) {
    return { instanceId, epoch, attempt }
  }

  const fifth = parts[4]
  const sixth = parts[5]
  if (parts.length === 6 && isNonEmptyString(fifth) && isNonEmptyString(sixth)) {
    return { instanceId, epoch, attempt, innerContentIdentity: fifth, innerEvidenceKey: sixth }
  }

  if (parts.length === 5 && typeof fifth === 'string' && fifth.startsWith('step:')) {
    const step = fifth.slice('step:'.length)
    return step.trim().length > 0 ? { instanceId, epoch, attempt, step } : null
  }

  if (typeof fifth === 'string' && fifth.startsWith('choice:')) {
    const parsedCause = PipelineChoiceCauseSchema.safeParse(fifth.slice('choice:'.length))
    if (parsedCause.success && parts.length === 5) {
      return { instanceId, epoch, attempt, cause: parsedCause.data }
    }
    if (parsedCause.success && parsedCause.data === 'time-limit' && isNonnegativeInteger(sixth)) {
      return { instanceId, epoch, attempt, cause: parsedCause.data, deadlineMs: sixth }
    }
  }
  return null
}
