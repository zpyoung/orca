import { describe, expect, it, vi } from 'vitest'
import type {
  ClientObservationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import {
  getActingJudgment,
  getJudgmentQuestionPolicy,
  HEIMDALL_JUDGMENT_QUESTION_IDS,
  HEIMDALL_JUDGMENT_REGISTRY
} from '../../../shared/fork-heimdall/judgment/registry'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { JudgmentClientFailure } from './client'
import type { JudgmentAccess, JudgmentClientPort } from './service'
import { StallCauseJudge } from './stall-cause-judge'
import { JudgmentAnswerStore, JUDGMENT_ANSWER_OBSERVATION } from './store'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the judge reads only watcherId and executionHostId.
const localEnrollment = { watcherId: 'watcher-1', executionHostId: 'local' } as WatcherEnrollment

const input = {
  dispatchId: 'dispatch-1',
  activity: 'waiting' as const,
  lastMessage: 'Should I keep both configs?'
}

function world(options: {
  access?: JudgmentAccess | (() => JudgmentAccess)
  evaluate?: JudgmentClientPort['evaluate']
  storageAuthority?: 'desktop' | 'runtime'
}) {
  const entries: LedgerEntry[] = []
  const store = new JudgmentAnswerStore({
    read: (watcherId): WatcherLedger => ({ watcherId, entries }),
    append: (entry: ClientObservationEntry) => entries.push(entry)
  })
  const evaluate = vi.fn(
    options.evaluate ??
      (async () => ({
        model: 'jev-1.13',
        answers: {
          'stall-cause': {
            type: 'choice' as const,
            choice: 'asked-question-in-prose',
            probabilities: { 'asked-question-in-prose': 0.97, 'idle-no-reason': 0.03 },
            confidence: 0.97
          }
        }
      }))
  )
  const access = options.access ?? { enabled: true, apiKey: 'key' }
  const judge = new StallCauseJudge({
    store,
    databasePath: () => '/profile/heimdall.db',
    readAccess: () => (typeof access === 'function' ? access() : access),
    createClient: () => ({ evaluate }),
    questionPolicy: getJudgmentQuestionPolicy,
    storageAuthority: () => options.storageAuthority ?? 'desktop'
  })
  const outcomes = () =>
    entries.flatMap((entry) =>
      entry.kind === 'client-observation' && entry.what === 'judgment-outcome'
        ? [JSON.parse(entry.detail ?? '{}').status]
        : []
    )
  return { entries, judge, evaluate, outcomes }
}

describe('StallCauseJudge', () => {
  it('records one shadow answer and replays it for the same idle episode', async () => {
    const { entries, judge, evaluate, outcomes } = world({})

    await expect(judge.judge(localEnrollment, input)).resolves.toBe('answered')
    await expect(judge.judge(localEnrollment, input)).resolves.toBe('replayed')

    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(evaluate.mock.calls[0]?.[0]).toEqual({
      agentStatus: 'waiting',
      lastMessage: 'Should I keep both configs?'
    })
    const answer = entries.find(
      (entry) => entry.kind === 'client-observation' && entry.what === JUDGMENT_ANSWER_OBSERVATION
    )
    expect(
      answer?.kind === 'client-observation' && JSON.parse(answer.detail ?? '{}')
    ).toMatchObject({ questionId: 'heimdall.stall-cause', subjectId: 'dispatch-1', mode: 'shadow' })
    expect(outcomes()).toEqual(['answered'])
  })

  it('judges a new episode once the message changes', async () => {
    const { judge, evaluate } = world({})
    await judge.judge(localEnrollment, input)
    await judge.judge(localEnrollment, { ...input, lastMessage: 'Done.' })
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a runtime storage authority', { storageAuthority: 'runtime' as const }, localEnrollment],
    [
      'a remote execution host',
      {},
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the judge reads only watcherId and executionHostId.
      { ...localEnrollment, executionHostId: 'ssh:box' } as WatcherEnrollment
    ]
  ])(
    'records remote once and never consults the model for %s',
    async (_label, options, enrollment) => {
      const { judge, evaluate, outcomes } = world(options)
      await expect(judge.judge(enrollment, input)).resolves.toBe('remote')
      await judge.judge(enrollment, input)
      expect(evaluate).not.toHaveBeenCalled()
      expect(outcomes()).toEqual(['remote'])
    }
  )

  it('records disabled once when judgment is off locally', async () => {
    const { judge, evaluate, outcomes } = world({ access: { enabled: false } })
    await expect(judge.judge(localEnrollment, input)).resolves.toBe('disabled')
    await judge.judge(localEnrollment, input)
    expect(evaluate).not.toHaveBeenCalled()
    expect(outcomes()).toEqual(['disabled'])
  })

  it('records a timeout as unavailable and does not retry the episode', async () => {
    const { judge, evaluate, outcomes } = world({
      evaluate: async () => {
        throw new JudgmentClientFailure('timed out', { code: 'timeout' })
      }
    })
    await expect(judge.judge(localEnrollment, input)).resolves.toBe('unavailable')
    await expect(judge.judge(localEnrollment, input)).resolves.toBe('replayed')
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(outcomes()).toEqual(['unavailable'])
  })

  it('coalesces concurrent considerations of one episode', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { judge, evaluate } = world({
      evaluate: async () => {
        await gate
        throw new JudgmentClientFailure('timed out', { code: 'timeout' })
      }
    })
    judge.consider(localEnrollment, input)
    judge.consider(localEnrollment, input)
    release()
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1))
  })
})

describe('heimdall.stall-cause registry entry', () => {
  it('is a shadow choice question with no calibrated model', () => {
    expect(HEIMDALL_JUDGMENT_REGISTRY[HEIMDALL_JUDGMENT_QUESTION_IDS.stallCause]).toEqual({
      mode: 'shadow',
      thresholdName: 'stall-cause-high-confidence',
      calibratedModel: null,
      answerType: 'choice',
      confidenceThreshold: 0.9,
      confidenceRule: 'greater-than'
    })
  })

  it('never yields an acting answer', () => {
    expect(
      getActingJudgment(
        {
          stateIdentity: 'state',
          contentIdentity: 'stall:dispatch-1',
          projectionDigest: 'projection',
          status: 'answered',
          answers: {
            'stall-cause': {
              questionId: HEIMDALL_JUDGMENT_QUESTION_IDS.stallCause,
              subjectId: 'dispatch-1',
              mode: 'acting',
              model: 'jev-1.13',
              answer: {
                type: 'choice',
                choice: 'asked-question-in-prose',
                probabilities: { 'asked-question-in-prose': 1 },
                confidence: 1
              }
            }
          },
          notices: []
        },
        HEIMDALL_JUDGMENT_QUESTION_IDS.stallCause,
        'dispatch-1'
      )
    ).toBeUndefined()
  })
})
