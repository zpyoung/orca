import { describe, expect, it } from 'vitest'
import type { JudgmentAnswer, JudgmentSnapshot } from './types'
import type { ObjectiveAction } from '../../fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../fork-heimdall-objective/detail-types'
import {
  judgmentFailureClassification,
  judgmentPreflightHold,
  judgmentQualityReviewSubjects
} from './objective-judgment-policy'
import {
  getActingJudgment,
  JUDGMENT_BASELINE_MODEL,
  OBJECTIVE_JUDGMENT_QUESTION_IDS,
  OBJECTIVE_JUDGMENT_REGISTRY,
  type JudgmentQuestionRegistry
} from './registry'
function snapshot(
  questionId: string,
  subjectId: string,
  answer: JudgmentAnswer,
  options: { mode?: 'shadow' | 'acting'; model?: string } = {}
): JudgmentSnapshot {
  const answers: JudgmentSnapshot['answers'] = {
    answer: {
      questionId,
      subjectId,
      mode: options.mode ?? 'acting',
      model: options.model ?? JUDGMENT_BASELINE_MODEL,
      answer
    }
  }
  if (questionId !== OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen) {
    answers.screen = {
      questionId: OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen,
      subjectId: 'worker-state',
      mode: 'acting',
      model: JUDGMENT_BASELINE_MODEL,
      answer: {
        type: 'choice',
        choice: 'clean',
        probabilities: { clean: 0.99, tainted: 0.01 },
        confidence: 0.99
      }
    }
  }
  return {
    stateIdentity: 'state-1',
    contentIdentity: 'content-1',
    projectionDigest: 'projection-1',
    status: 'answered',
    answers,
    notices: []
  }
}

function actingRegistry(...questionIds: string[]): JudgmentQuestionRegistry {
  return Object.fromEntries(
    Object.entries(OBJECTIVE_JUDGMENT_REGISTRY).map(([questionId, policy]) => [
      questionId,
      questionIds.includes(questionId) ||
      (questionIds.length > 0 &&
        questionId === OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen)
        ? {
            ...policy,
            mode: 'acting' as const,
            calibratedModel: JUDGMENT_BASELINE_MODEL
          }
        : policy
    ])
  )
}

const failureAnswer = (confidence: number): JudgmentAnswer => ({
  type: 'choice',
  choice: 'environment',
  probabilities: { infra: 0.02, environment: 0.96, criteria: 0.02 },
  confidence
})

describe('objective judgment authority gate', () => {
  const failureQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification

  it('keeps current registry questions shadow and prevents retroactive authority', () => {
    const recordedShadow = snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99), {
      mode: 'shadow'
    })

    expect(getActingJudgment(recordedShadow, failureQuestion, 'dispatch-1')).toBeUndefined()
    expect(
      getActingJudgment(
        recordedShadow,
        failureQuestion,
        'dispatch-1',
        actingRegistry(failureQuestion)
      )
    ).toBeUndefined()
  })

  it('withholds all non-screen authority when the worker-state screen is missing', () => {
    const state = snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99))
    delete state.answers.screen

    expect(
      getActingJudgment(state, failureQuestion, 'dispatch-1', actingRegistry(failureQuestion))
    ).toBeUndefined()
  })

  it('requires confidence strictly above the published high tier', () => {
    const registry = actingRegistry(failureQuestion)

    expect(
      getActingJudgment(
        snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.9)),
        failureQuestion,
        'dispatch-1',
        registry
      )
    ).toBeUndefined()
    expect(
      getActingJudgment(
        snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.900_001)),
        failureQuestion,
        'dispatch-1',
        registry
      )
    ).toEqual(failureAnswer(0.900_001))
  })

  it('accepts the published uncertain boundary only for its own score question', () => {
    const reportQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality
    const answer: JudgmentAnswer = {
      type: 'score',
      score: 1.5,
      legend: { '0': 'incomplete', '1': 'partial', '2': 'adequate', '3': 'strong' },
      probabilities: { '0': 0.2, '1': 0.4, '2': 0.3, '3': 0.1 },
      confidence: 0.5
    }

    expect(
      getActingJudgment(
        snapshot(reportQuestion, 'dispatch-1', answer),
        reportQuestion,
        'dispatch-1',
        actingRegistry(reportQuestion)
      )
    ).toEqual(answer)
  })

  it('rejects answers from a model other than the calibrated pinned version', () => {
    expect(
      getActingJudgment(
        snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99), {
          model: 'jev-next'
        }),
        failureQuestion,
        'dispatch-1',
        actingRegistry(failureQuestion)
      )
    ).toBeUndefined()
  })

  it('withholds authority while worker-authored state has only a shadow screen', () => {
    const adversarialQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen
    const state = snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99))
    state.answers.screen = {
      questionId: adversarialQuestion,
      subjectId: 'dispatch-1',
      mode: 'shadow',
      model: JUDGMENT_BASELINE_MODEL,
      answer: {
        type: 'choice',
        choice: 'clean',
        probabilities: { clean: 0.99, tainted: 0.01 },
        confidence: 0.99
      }
    }

    expect(
      getActingJudgment(state, failureQuestion, 'dispatch-1', actingRegistry(failureQuestion))
    ).toBeUndefined()
  })

  it('suppresses other answers when an authoritative adversarial screen is tainted', () => {
    const adversarialQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.adversarialPrescreen
    const state = snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99))
    state.answers.screen = {
      questionId: adversarialQuestion,
      subjectId: 'dispatch-1',
      mode: 'acting',
      model: JUDGMENT_BASELINE_MODEL,
      answer: {
        type: 'choice',
        choice: 'tainted',
        probabilities: { clean: 0.01, tainted: 0.99 },
        confidence: 0.99
      }
    }

    expect(
      getActingJudgment(
        state,
        failureQuestion,
        'dispatch-1',
        actingRegistry(failureQuestion, adversarialQuestion)
      )
    ).toBeUndefined()
  })
  it('keeps a preflight hold shadow until both policy and recorded mode are acting', () => {
    const preflightQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.preflight
    const answer: JudgmentAnswer = {
      type: 'choice',
      choice: 'hold',
      probabilities: { proceed: 0.01, hold: 0.99 },
      confidence: 0.99
    }
    const action = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      contentIdentity: 'content-1',
      evidenceKey: 'revision-1:core',
      revisionId: 'revision-1',
      taskKey: 'core',
      depsOrchestrationIds: []
    } satisfies ObjectiveAction
    const shadowWorld = {
      judgment: snapshot(preflightQuestion, 'implement', answer, { mode: 'shadow' })
    } as ObjectiveWorld
    const actingWorld = {
      judgment: snapshot(preflightQuestion, 'implement', answer)
    } as ObjectiveWorld

    expect(judgmentPreflightHold(shadowWorld, action)).toBeNull()
    expect(judgmentPreflightHold(actingWorld, action, actingRegistry(preflightQuestion))).toBe(
      'judgment preflight held implement'
    )
  })

  it('widens only a criteria fallback and preserves stronger deterministic classes', () => {
    const failureQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.failureClassification
    const registry = actingRegistry(failureQuestion)
    const actingWorld = {
      judgment: snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99))
    } as ObjectiveWorld
    const shadowWorld = {
      judgment: snapshot(failureQuestion, 'dispatch-1', failureAnswer(0.99), {
        mode: 'shadow'
      })
    } as ObjectiveWorld

    expect(judgmentFailureClassification(actingWorld, 'dispatch-1', 'criteria', registry)).toBe(
      'environment'
    )
    expect(judgmentFailureClassification(actingWorld, 'dispatch-1', 'infra', registry)).toBe(
      'infra'
    )
    expect(judgmentFailureClassification(actingWorld, 'dispatch-1', 'environment', registry)).toBe(
      'environment'
    )
    expect(judgmentFailureClassification(shadowWorld, 'dispatch-1', 'criteria', registry)).toBe(
      'criteria'
    )
  })

  it('turns a low quality score into a review subject only in acting mode', () => {
    const reportQuestion = OBJECTIVE_JUDGMENT_QUESTION_IDS.reportQuality
    const answer: JudgmentAnswer = {
      type: 'score',
      score: 1.75,
      legend: { '0': 'incomplete', '1': 'partial', '2': 'adequate', '3': 'strong' },
      probabilities: { '0': 0.15, '1': 0.45, '2': 0.3, '3': 0.1 },
      confidence: 0.7
    }
    const shadowWorld = {
      judgment: snapshot(reportQuestion, 'dispatch-1', answer, { mode: 'shadow' })
    } as ObjectiveWorld
    const actingWorld = {
      judgment: snapshot(reportQuestion, 'dispatch-1', answer)
    } as ObjectiveWorld

    expect(judgmentQualityReviewSubjects(shadowWorld)).toEqual([])
    expect(judgmentQualityReviewSubjects(actingWorld, actingRegistry(reportQuestion))).toEqual([
      'dispatch-1'
    ])
  })
})
