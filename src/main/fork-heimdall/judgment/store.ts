import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type {
  ClientObservationEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import {
  JudgmentAnswerSchema,
  JudgmentModelSchema,
  JudgmentProviderSchema,
  type JudgmentProvider,
  type JudgmentRecordedAnswer,
  type JudgmentSnapshot
} from '../../../shared/fork-heimdall/judgment/types'

export const JUDGMENT_PENDING_OBSERVATION = 'judgment-pending'
export const JUDGMENT_ANSWER_OBSERVATION = 'judgment-answer'
export const JUDGMENT_OUTCOME_OBSERVATION = 'judgment-outcome'
export const JUDGMENT_MODEL_VERSION_OBSERVATION = 'judgment-model-version'

const IdSchema = z.string().trim().min(1)
const IdentitySchema = z
  .object({
    stateIdentity: IdSchema,
    contentIdentity: IdSchema,
    projectionDigest: IdSchema
  })
  .strict()

const PendingDetailSchema = IdentitySchema.extend({
  requestIds: z.array(IdSchema)
}).strict()

const AnswerDetailSchema = IdentitySchema.extend({
  requestId: IdSchema,
  questionId: IdSchema,
  subjectId: IdSchema,
  mode: z.enum(['shadow', 'acting']),
  thresholdName: IdSchema,
  calibratedModel: IdSchema.nullable(),
  provider: JudgmentProviderSchema.optional(),
  model: JudgmentModelSchema,
  answer: JudgmentAnswerSchema
}).strict()

const OutcomeDetailSchema = IdentitySchema.extend({
  status: z.enum(['answered', 'unavailable', 'disabled', 'remote', 'not-applicable']),
  reason: z.string().min(1).optional()
}).strict()

const ModelVersionDetailSchema = z
  .object({
    model: JudgmentModelSchema,
    notice: z.string().min(1)
  })
  .strict()

export type JudgmentIdentity = z.infer<typeof IdentitySchema>
export type JudgmentRecordedPolicy = {
  mode: 'shadow' | 'acting'
  thresholdName: string
  calibratedModel: string | null
}
export type StoredJudgmentAnswer = z.infer<typeof AnswerDetailSchema>

export type JudgmentLedgerPort = {
  read(watcherId: string): WatcherLedger
  append(entry: ClientObservationEntry, options?: { resolved?: boolean }): number
}

export type JudgmentPersistencePort = JudgmentLedgerPort & {
  databasePath(): string
}

export type JudgmentHistory = {
  answers: Record<string, JudgmentRecordedAnswer>
  answerDetails: Record<string, StoredJudgmentAnswer>
  pending: boolean
  terminal: Extract<
    JudgmentSnapshot['status'],
    'answered' | 'unavailable' | 'not-applicable'
  > | null
  reason?: string
}

function parseDetail<T>(schema: z.ZodType<T>, detail: string | undefined): T | null {
  if (detail === undefined) {
    return null
  }
  try {
    const parsed = schema.safeParse(JSON.parse(detail))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function matchesIdentity(detail: JudgmentIdentity, identity: JudgmentIdentity): boolean {
  return (
    detail.stateIdentity === identity.stateIdentity &&
    detail.contentIdentity === identity.contentIdentity &&
    detail.projectionDigest === identity.projectionDigest
  )
}

export class JudgmentAnswerStore {
  private readonly now: () => number
  private readonly createId: () => string

  constructor(
    private readonly ledger: JudgmentLedgerPort,
    options: { now?: () => number; createId?: () => string } = {}
  ) {
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  readLedger(watcherId: string): WatcherLedger {
    return this.ledger.read(watcherId)
  }

  history(watcherId: string, identity: JudgmentIdentity): JudgmentHistory {
    const answers: Record<string, JudgmentRecordedAnswer> = {}
    const answerDetails: Record<string, StoredJudgmentAnswer> = {}
    let pending = false
    let terminal: JudgmentHistory['terminal'] = null
    let reason: string | undefined

    for (const entry of this.ledger.read(watcherId).entries) {
      if (entry.kind !== 'client-observation') {
        continue
      }
      if (entry.what === JUDGMENT_PENDING_OBSERVATION) {
        const detail = parseDetail(PendingDetailSchema, entry.detail)
        if (detail && matchesIdentity(detail, identity)) {
          pending = true
        }
        continue
      }
      if (entry.what === JUDGMENT_ANSWER_OBSERVATION) {
        const detail = parseDetail(AnswerDetailSchema, entry.detail)
        if (!detail || !matchesIdentity(detail, identity)) {
          continue
        }
        answerDetails[detail.requestId] = detail
        answers[detail.requestId] = {
          questionId: detail.questionId,
          subjectId: detail.subjectId,
          mode: detail.mode,
          ...(detail.provider ? { provider: detail.provider } : {}),
          model: detail.model,
          answer: detail.answer
        }
        continue
      }
      if (entry.what !== JUDGMENT_OUTCOME_OBSERVATION) {
        continue
      }
      const detail = parseDetail(OutcomeDetailSchema, entry.detail)
      if (!detail || !matchesIdentity(detail, identity)) {
        continue
      }
      if (detail.status === 'answered') {
        terminal = 'answered'
        reason = detail.reason
      } else if (
        terminal !== 'answered' &&
        (detail.status === 'unavailable' || detail.status === 'not-applicable')
      ) {
        terminal = detail.status
        reason = detail.reason
      }
    }
    return { answers, answerDetails, pending, terminal, ...(reason ? { reason } : {}) }
  }
  hasOutcome(
    watcherId: string,
    identity: JudgmentIdentity,
    status: z.infer<typeof OutcomeDetailSchema>['status']
  ): boolean {
    return this.ledger.read(watcherId).entries.some((entry) => {
      if (entry.kind !== 'client-observation' || entry.what !== JUDGMENT_OUTCOME_OBSERVATION) {
        return false
      }
      const detail = parseDetail(OutcomeDetailSchema, entry.detail)
      return detail !== null && matchesIdentity(detail, identity) && detail.status === status
    })
  }

  hasModelVersion(watcherId: string, model: string): boolean {
    return this.ledger.read(watcherId).entries.some((entry) => {
      if (
        entry.kind !== 'client-observation' ||
        entry.what !== JUDGMENT_MODEL_VERSION_OBSERVATION
      ) {
        return false
      }
      return parseDetail(ModelVersionDetailSchema, entry.detail)?.model === model
    })
  }

  recordPending(
    watcherId: string,
    identity: JudgmentIdentity,
    requestIds: readonly string[]
  ): void {
    this.append(watcherId, JUDGMENT_PENDING_OBSERVATION, {
      ...identity,
      requestIds: [...requestIds]
    })
  }

  recordAnswer(
    watcherId: string,
    identity: JudgmentIdentity,
    request: { id: string; questionId: string; subjectId: string },
    policy: JudgmentRecordedPolicy,
    provider: JudgmentProvider,
    model: string,
    answer: z.infer<typeof JudgmentAnswerSchema>
  ): void {
    this.append(watcherId, JUDGMENT_ANSWER_OBSERVATION, {
      ...identity,
      requestId: request.id,
      questionId: request.questionId,
      subjectId: request.subjectId,
      ...policy,
      provider,
      model,
      answer
    })
  }

  recordOutcome(
    watcherId: string,
    identity: JudgmentIdentity,
    status: z.infer<typeof OutcomeDetailSchema>['status'],
    reason?: string
  ): void {
    this.append(watcherId, JUDGMENT_OUTCOME_OBSERVATION, {
      ...identity,
      status,
      ...(reason ? { reason } : {})
    })
  }

  recordModelVersion(watcherId: string, model: string, notice: string): void {
    this.append(watcherId, JUDGMENT_MODEL_VERSION_OBSERVATION, { model, notice })
  }

  private append(watcherId: string, what: string, detail: unknown): void {
    this.ledger.append(
      {
        eventId: this.createId(),
        watcherId,
        atMs: this.now(),
        origin: 'client',
        class: 'observation',
        kind: 'client-observation',
        what,
        detail: JSON.stringify(detail)
      },
      // Judgment history is the durable replay source. It is never eligible for ring eviction.
      { resolved: false }
    )
  }
}
