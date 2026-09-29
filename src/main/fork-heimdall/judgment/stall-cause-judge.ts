import { createHash } from 'node:crypto'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  getJudgmentQuestionPolicy,
  HEIMDALL_JUDGMENT_QUESTION_IDS
} from '../../../shared/fork-heimdall/judgment/registry'
import {
  STALL_CAUSE_REQUEST_ID,
  stallCauseQuestionRequest
} from '../../../shared/fork-heimdall/judgment/stall-cause-question'
import type { JudgmentProvider } from '../../../shared/fork-heimdall/judgment/types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { StallCauseInput, StallCauseJudgePort } from '../stall-scan'
import { readJudgmentAccess } from './access-store'
import { createJudgmentClient } from './client'
import { evaluationFailureReason } from './failure-reason'
import { partialResponseReason, validateClientResponse } from './response-validation'
import type { JudgmentAccess, JudgmentClientPort, JudgmentQuestionPolicy } from './service'
import { stableJson } from './state-projection'
import { JudgmentAnswerStore, type JudgmentIdentity, type JudgmentPersistencePort } from './store'

const STALL_CAUSE_PROJECTION = 'heimdall-stall-cause-v1'

export type StallCauseJudgeDependencies = {
  store: JudgmentAnswerStore
  databasePath(): string
  readAccess(databasePath: string): JudgmentAccess
  createClient(apiKey: string, options: { provider: JudgmentProvider }): JudgmentClientPort
  questionPolicy(questionId: string): JudgmentQuestionPolicy | null
  storageAuthority(): 'desktop' | 'runtime'
}

export type StallCauseOutcome = 'answered' | 'replayed' | 'remote' | 'disabled' | 'unavailable'

function stallCauseIdentity(input: StallCauseInput): JudgmentIdentity {
  const state = {
    dispatchId: input.dispatchId,
    activity: input.activity,
    lastMessage: input.lastMessage
  }
  return {
    stateIdentity: createHash('sha256').update(stableJson(state)).digest('hex'),
    contentIdentity: `stall:${input.dispatchId}`,
    projectionDigest: STALL_CAUSE_PROJECTION
  }
}

/**
 * Records a shadow answer to "why did this worker go idle?" once per idle episode. Nothing reads
 * the answer; it exists to measure whether the question could later be trusted to act. Consulted
 * only on the desktop for a local workspace, mirroring the objective kind's judgment authority.
 */
export class StallCauseJudge implements StallCauseJudgePort {
  private readonly inflight = new Set<string>()

  constructor(private readonly dependencies: StallCauseJudgeDependencies) {}

  consider(enrollment: WatcherEnrollment, input: StallCauseInput): void {
    const key = `${enrollment.watcherId}:${stallCauseIdentity(input).stateIdentity}`
    if (this.inflight.has(key)) {
      return
    }
    this.inflight.add(key)
    void this.judge(enrollment, input)
      .catch((error: unknown) => {
        console.warn('[heimdall] stall-cause judgment failed:', error)
      })
      .finally(() => this.inflight.delete(key))
  }

  async judge(enrollment: WatcherEnrollment, input: StallCauseInput): Promise<StallCauseOutcome> {
    const { store } = this.dependencies
    const watcherId = enrollment.watcherId
    const identity = stallCauseIdentity(input)
    const recordOnce = (
      status: 'remote' | 'disabled' | 'unavailable',
      reason: string
    ): StallCauseOutcome => {
      if (!store.hasOutcome(watcherId, identity, status)) {
        store.recordOutcome(watcherId, identity, status, reason)
      }
      return status
    }
    if (
      this.dependencies.storageAuthority() !== 'desktop' ||
      enrollment.executionHostId !== LOCAL_EXECUTION_HOST_ID
    ) {
      return recordOnce('remote', 'judgment not consulted: remote storage or execution host')
    }
    let access: JudgmentAccess
    try {
      access = this.dependencies.readAccess(this.dependencies.databasePath())
    } catch {
      return recordOnce(
        'unavailable',
        'judgment unavailable: local access configuration is invalid'
      )
    }
    if (!access.enabled) {
      return recordOnce('disabled', 'judgment not consulted: disabled locally')
    }
    const history = store.history(watcherId, identity)
    if (history.terminal !== null || history.pending) {
      return 'replayed'
    }
    const policy = this.dependencies.questionPolicy(HEIMDALL_JUDGMENT_QUESTION_IDS.stallCause)
    if (!policy) {
      return recordOnce(
        'unavailable',
        'judgment unavailable: registered question policy is missing'
      )
    }
    const request = stallCauseQuestionRequest(input.dispatchId)
    const provider = access.provider ?? 'typesafe'
    store.recordPending(watcherId, identity, [request.id])
    try {
      const response = await this.dependencies
        .createClient(access.apiKey, { provider })
        .evaluate(
          { agentStatus: input.activity, lastMessage: input.lastMessage },
          { [STALL_CAUSE_REQUEST_ID]: request.question }
        )
      const validated = validateClientResponse(response, [request])
      const answer = validated.answers.get(STALL_CAUSE_REQUEST_ID)
      if (answer === undefined) {
        return recordOnce('unavailable', partialResponseReason(0, 1, validated.unavailable))
      }
      store.recordAnswer(watcherId, identity, request, policy, provider, validated.model, answer)
      store.recordOutcome(watcherId, identity, 'answered')
      return 'answered'
    } catch (error) {
      store.recordOutcome(watcherId, identity, 'unavailable', evaluationFailureReason(error))
      return 'unavailable'
    }
  }
}

export function createStallCauseJudge(
  persistence: JudgmentPersistencePort,
  storageAuthority: () => 'desktop' | 'runtime'
): StallCauseJudge {
  return new StallCauseJudge({
    store: new JudgmentAnswerStore(persistence),
    databasePath: () => persistence.databasePath(),
    readAccess: readJudgmentAccess,
    createClient: createJudgmentClient,
    questionPolicy: getJudgmentQuestionPolicy,
    storageAuthority
  })
}
