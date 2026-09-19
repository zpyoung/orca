import {
  JudgmentAnswerSchema,
  JudgmentModelSchema,
  JudgmentQuestionRequestSchema,
  JudgmentSnapshotSchema,
  type JudgmentAnswer,
  type JudgmentProvider,
  type JudgmentQuestion,
  type JudgmentQuestionRequest,
  type JudgmentSnapshot
} from '../../../shared/fork-heimdall/judgment/types'
import { OBJECTIVE_JUDGMENT_QUESTION_IDS } from '../../../shared/fork-heimdall/judgment/registry'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import { judgmentRequestFitsTransportLimits } from './client'
import { computeJudgmentIdentity, type ComputedJudgmentIdentity } from './identity'
import { expandJudgmentState, JUDGMENT_STATE_NORMALIZATION_GUIDANCE } from './state-normalization'
import type {
  JudgmentAnswerStore,
  JudgmentHistory,
  JudgmentIdentity,
  JudgmentRecordedPolicy,
  StoredJudgmentAnswer
} from './store'

export const JUDGMENT_MAX_STATE_BYTES = 32 * 1024
const OMITTABLE_HISTORICAL_QUESTION_IDS: Record<string, true> = {
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen]: true,
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification]: true,
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality]: true,
  [OBJECTIVE_JUDGMENT_QUESTION_IDS.verdictQuality]: true
}

export type JudgmentAuthority =
  | 'local-desktop'
  | 'remote-storage-authority'
  | 'remote-execution-host'

export type JudgmentAccess =
  | { enabled: false }
  | { enabled: true; provider?: JudgmentProvider; apiKey: string }

export type JudgmentClientPort = {
  evaluate(
    state: unknown,
    questions: Record<string, JudgmentQuestion>
  ): Promise<{ model: string; answers: Record<string, JudgmentAnswer> }>
}

export type JudgmentQuestionPolicy = JudgmentRecordedPolicy

export type JudgmentServiceDependencies = {
  store: JudgmentAnswerStore
  databasePath(): string
  readAccess(databasePath: string): JudgmentAccess
  createClient(apiKey: string, options: { provider: JudgmentProvider }): JudgmentClientPort
  questionPolicy(questionId: string): JudgmentQuestionPolicy | null
  maxStateBytes?: number
}

export type JudgmentEvaluation = {
  watcherId: string
  contentIdentity: string
  world: ObjectiveWorld
  requests: readonly JudgmentQuestionRequest[]
  authority: JudgmentAuthority
}

function snapshot(
  identity: JudgmentIdentity,
  status: JudgmentSnapshot['status'],
  answers: JudgmentSnapshot['answers'],
  reason?: string,
  notices: string[] = []
): JudgmentSnapshot {
  return JudgmentSnapshotSchema.parse({
    ...identity,
    status,
    ...(reason ? { reason } : {}),
    answers,
    notices
  })
}

function answeredReason(details: Record<string, StoredJudgmentAnswer>): string {
  const values = Object.values(details)
  const shadow = values.filter((answer) => answer.mode === 'shadow').length
  const uncalibrated = values.filter(
    (answer) =>
      answer.mode === 'acting' &&
      (answer.calibratedModel === null || answer.calibratedModel !== answer.model)
  ).length
  const authoritativeCandidates = values.length - shadow - uncalibrated
  return [
    `${values.length} answer(s) recorded`,
    `${shadow} shadow-held`,
    `${uncalibrated} model-held`,
    `${authoritativeCandidates} threshold-gated`
  ].join('; ')
}

function remoteReason(authority: Exclude<JudgmentAuthority, 'local-desktop'>): string {
  return authority === 'remote-storage-authority'
    ? 'judgment not consulted: runtime storage authority'
    : 'judgment not consulted: remote execution host'
}

function validatedRequests(
  requests: readonly JudgmentQuestionRequest[]
): JudgmentQuestionRequest[] | null {
  const parsed: JudgmentQuestionRequest[] = []
  const ids = new Set<string>()
  for (const request of requests) {
    const result = JudgmentQuestionRequestSchema.safeParse(request)
    if (!result.success || ids.has(result.data.id)) {
      return null
    }
    ids.add(result.data.id)
    parsed.push(result.data)
  }
  return parsed
}

function withStateNotices(reason: string, notices: readonly string[]): string {
  return notices.length === 0 ? reason : `${reason}; ${notices.join(' ')}`
}

function withNormalizationGuidance(question: JudgmentQuestion): JudgmentQuestion {
  return {
    ...question,
    instructions: `${JUDGMENT_STATE_NORMALIZATION_GUIDANCE}\n\n${question.instructions}`
  }
}

function identityFor(computed: ComputedJudgmentIdentity): JudgmentIdentity {
  return {
    stateIdentity: computed.stateIdentity,
    contentIdentity: computed.contentIdentity,
    projectionDigest: computed.projectionDigest
  }
}

function requestsForState(
  validated: readonly JudgmentQuestionRequest[],
  computed: ComputedJudgmentIdentity
): JudgmentQuestionRequest[] {
  const omittedSubjects = new Set(computed.omittedQuestionSubjectIds)
  return validated.filter(
    (request) =>
      !omittedSubjects.has(request.subjectId) ||
      (request.questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen &&
        request.subjectId === 'worker-state') ||
      OMITTABLE_HISTORICAL_QUESTION_IDS[request.questionId] !== true
  )
}

function noticesForState(computed: ComputedJudgmentIdentity): string[] {
  return [computed.normalizationNotice, computed.truncationNotice].filter(
    (notice): notice is string => notice !== null
  )
}

function questionsForState(
  requests: readonly JudgmentQuestionRequest[],
  normalized: boolean
): Record<string, JudgmentQuestion> {
  return Object.fromEntries(
    requests.map((request) => [
      request.id,
      normalized ? withNormalizationGuidance(request.question) : request.question
    ])
  )
}

function replaySuccessfulHistory(
  identity: JudgmentIdentity,
  history: JudgmentHistory,
  requests: readonly JudgmentQuestionRequest[],
  notices: string[]
): JudgmentSnapshot | null {
  if (history.terminal === 'answered') {
    const complete =
      Object.keys(history.answers).length === requests.length &&
      requests.every((request) => history.answers[request.id] !== undefined)
    return complete
      ? snapshot(
          identity,
          'answered',
          history.answers,
          answeredReason(history.answerDetails),
          notices
        )
      : snapshot(
          identity,
          'unavailable',
          history.answers,
          'judgment unavailable: recorded answer set is incomplete',
          notices
        )
  }
  return history.pending && history.terminal === null
    ? snapshot(
        identity,
        'pending',
        history.answers,
        'judgment request was durably started; replay will not repeat it',
        notices
      )
    : null
}

export class JudgmentService {
  private readonly maxStateBytes: number

  constructor(private readonly dependencies: JudgmentServiceDependencies) {
    this.maxStateBytes = dependencies.maxStateBytes ?? JUDGMENT_MAX_STATE_BYTES
  }
  canCollectReportEvidence(authority: JudgmentAuthority): boolean {
    if (authority !== 'local-desktop') {
      return false
    }
    try {
      return this.dependencies.readAccess(this.dependencies.databasePath()).enabled
    } catch {
      return false
    }
  }

  readLedger(watcherId: string): WatcherLedger {
    return this.dependencies.store.readLedger(watcherId)
  }

  async evaluate(input: JudgmentEvaluation): Promise<JudgmentSnapshot> {
    const ledger = this.dependencies.store.readLedger(input.watcherId)
    let computed = computeJudgmentIdentity(input.contentIdentity, input.world, ledger, {
      maxStateBytes: this.maxStateBytes
    })
    let identity = identityFor(computed)
    const validated = validatedRequests(input.requests)
    let requests = validated === null ? null : requestsForState(validated, computed)
    let notices = noticesForState(computed)

    if (input.authority !== 'local-desktop') {
      const history = this.dependencies.store.history(input.watcherId, identity)
      const reason = remoteReason(input.authority)
      if (!this.dependencies.store.hasOutcome(input.watcherId, identity, 'remote')) {
        this.dependencies.store.recordOutcome(
          input.watcherId,
          identity,
          'remote',
          withStateNotices(reason, notices)
        )
      }
      return snapshot(identity, 'remote', history.answers, reason, notices)
    }

    let access: JudgmentAccess
    try {
      access = this.dependencies.readAccess(this.dependencies.databasePath())
    } catch {
      const history = this.dependencies.store.history(input.watcherId, identity)
      const reason = 'judgment unavailable: local access configuration is invalid'
      if (!this.dependencies.store.hasOutcome(input.watcherId, identity, 'unavailable')) {
        this.dependencies.store.recordOutcome(
          input.watcherId,
          identity,
          'unavailable',
          withStateNotices(reason, notices)
        )
      }
      return snapshot(identity, 'unavailable', history.answers, reason, notices)
    }

    if (!access.enabled) {
      const history = this.dependencies.store.history(input.watcherId, identity)
      const reason = 'judgment not consulted: disabled locally'
      if (!this.dependencies.store.hasOutcome(input.watcherId, identity, 'disabled')) {
        this.dependencies.store.recordOutcome(
          input.watcherId,
          identity,
          'disabled',
          withStateNotices(reason, notices)
        )
      }
      return snapshot(identity, 'disabled', history.answers, reason, notices)
    }
    if (validated === null || requests === null) {
      const history = this.dependencies.store.history(input.watcherId, identity)
      const reason = 'judgment unavailable: registered questions are invalid'
      if (!this.dependencies.store.hasOutcome(input.watcherId, identity, 'unavailable')) {
        this.dependencies.store.recordOutcome(
          input.watcherId,
          identity,
          'unavailable',
          withStateNotices(reason, notices)
        )
      }
      return snapshot(identity, 'unavailable', history.answers, reason, notices)
    }

    if (requests.length === 0) {
      const history = this.dependencies.store.history(input.watcherId, identity)
      const reason = 'no active judgment questions for this state'
      if (!this.dependencies.store.hasOutcome(input.watcherId, identity, 'not-applicable')) {
        this.dependencies.store.recordOutcome(
          input.watcherId,
          identity,
          'not-applicable',
          withStateNotices(reason, notices)
        )
      }
      return snapshot(identity, 'not-applicable', history.answers, reason, notices)
    }

    const provider = access.provider ?? 'typesafe'
    let questions = questionsForState(requests, computed.normalization !== null)
    let requestFits = judgmentRequestFitsTransportLimits(provider, computed.state, questions)
    let history = this.dependencies.store.history(input.watcherId, identity)
    const normalizedReplay = replaySuccessfulHistory(identity, history, requests, notices)
    if (normalizedReplay !== null) {
      return normalizedReplay
    }

    let rawCandidate: {
      computed: ComputedJudgmentIdentity
      identity: JudgmentIdentity
      requests: JudgmentQuestionRequest[]
      notices: string[]
      questions: Record<string, JudgmentQuestion>
      history: JudgmentHistory
      requestFits: boolean
    } | null = null
    if (computed.normalization !== null) {
      const raw = computeJudgmentIdentity(input.contentIdentity, input.world, ledger, {
        maxStateBytes: this.maxStateBytes,
        normalize: false
      })
      const rawIdentity = identityFor(raw)
      const rawRequests = requestsForState(validated, raw)
      const rawNotices = noticesForState(raw)
      const rawQuestions = questionsForState(rawRequests, false)
      const rawHistory = this.dependencies.store.history(input.watcherId, rawIdentity)
      const sameExpandedState =
        raw.serializedState === JSON.stringify(expandJudgmentState(computed.state))
      const rawReplay = sameExpandedState
        ? replaySuccessfulHistory(rawIdentity, rawHistory, rawRequests, rawNotices)
        : null
      if (rawReplay !== null) {
        return rawReplay
      }
      rawCandidate = {
        computed: raw,
        identity: rawIdentity,
        requests: rawRequests,
        notices: rawNotices,
        questions: rawQuestions,
        history: rawHistory,
        requestFits:
          raw.fitsStateBudget &&
          raw.serializedBytes <= this.maxStateBytes &&
          judgmentRequestFitsTransportLimits(provider, raw.state, rawQuestions)
      }
    }

    if (!requestFits && rawCandidate?.requestFits) {
      computed = rawCandidate.computed
      identity = rawCandidate.identity
      requests = rawCandidate.requests
      notices = rawCandidate.notices
      questions = rawCandidate.questions
      history = rawCandidate.history
      requestFits = true
    }
    const selectedReplay = replaySuccessfulHistory(identity, history, requests, notices)
    if (selectedReplay !== null) {
      return selectedReplay
    }
    if (history.terminal === 'unavailable') {
      return snapshot(
        identity,
        'unavailable',
        history.answers,
        history.reason ?? 'judgment unavailable for this state',
        notices
      )
    }

    const policies = new Map<string, JudgmentQuestionPolicy>()
    for (const request of requests) {
      const policy = this.dependencies.questionPolicy(request.questionId)
      if (policy === null) {
        const reason = 'judgment unavailable: registered question policy is missing'
        this.dependencies.store.recordOutcome(
          input.watcherId,
          identity,
          'unavailable',
          withStateNotices(reason, notices)
        )
        return snapshot(identity, 'unavailable', history.answers, reason, notices)
      }
      policies.set(request.id, policy)
    }

    const stateExceedsBudget =
      !computed.fitsStateBudget || computed.serializedBytes > this.maxStateBytes
    if (stateExceedsBudget || !requestFits) {
      const reason = stateExceedsBudget
        ? `judgment unavailable: mandatory state exceeds the ${this.maxStateBytes}-byte limit`
        : 'judgment unavailable: evaluation request exceeds transport limits'
      this.dependencies.store.recordOutcome(
        input.watcherId,
        identity,
        'unavailable',
        withStateNotices(reason, notices)
      )
      return snapshot(identity, 'unavailable', history.answers, reason, notices)
    }

    this.dependencies.store.recordPending(
      input.watcherId,
      identity,
      requests.map((request) => request.id)
    )

    try {
      const response = await this.dependencies
        .createClient(access.apiKey, { provider })
        .evaluate(computed.state, questions)
      const responseIds = Object.keys(response.answers)
      if (
        !JudgmentModelSchema.safeParse(response.model).success ||
        responseIds.length !== requests.length ||
        requests.some(
          (request) =>
            response.answers[request.id] === undefined ||
            !JudgmentAnswerSchema.safeParse(response.answers[request.id]).success
        )
      ) {
        throw new Error('invalid judgment response')
      }

      if (!this.dependencies.store.hasModelVersion(input.watcherId, response.model)) {
        const notice = `Judgment model ${response.model} observed; acting thresholds require explicit calibration for this exact model.`
        this.dependencies.store.recordModelVersion(input.watcherId, response.model, notice)
        notices.push(notice)
      }
      for (const request of requests) {
        this.dependencies.store.recordAnswer(
          input.watcherId,
          identity,
          request,
          policies.get(request.id)!,
          provider,
          response.model,
          response.answers[request.id]!
        )
      }
      this.dependencies.store.recordOutcome(
        input.watcherId,
        identity,
        'answered',
        notices.length === 0 ? undefined : notices.join(' ')
      )
      const recorded = this.dependencies.store.history(input.watcherId, identity)
      return snapshot(
        identity,
        'answered',
        recorded.answers,
        answeredReason(recorded.answerDetails),
        notices
      )
    } catch {
      const reason = 'judgment unavailable: evaluation failed'
      this.dependencies.store.recordOutcome(
        input.watcherId,
        identity,
        'unavailable',
        withStateNotices(reason, notices)
      )
      return snapshot(identity, 'unavailable', history.answers, reason, notices)
    }
  }
}
