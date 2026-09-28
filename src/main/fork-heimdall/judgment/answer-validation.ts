import { z } from 'zod'
import {
  JudgmentAnswerSchema,
  type JudgmentAnswer,
  type JudgmentProvider,
  type JudgmentQuestion
} from '../../../shared/fork-heimdall/judgment/types'

export const JudgmentUnavailableReasonSchema = z.enum([
  'missing-answer',
  'answer-shape',
  'answer-type',
  'missing-confidence',
  'missing-probabilities',
  'score-weight-mismatch',
  'score-legend',
  'score-range',
  'probability-keys',
  'probability-distribution',
  'choice-invalid',
  'choice-not-max'
])
export type JudgmentUnavailableReason = z.infer<typeof JudgmentUnavailableReasonSchema>

const DISTRIBUTION_TOLERANCE = 1e-6

const OpenRouterChoiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().optional()
  })
  .strict()

const OpenRouterScoreAnswerSchema = z
  .object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.unknown()).optional(),
    probabilities: z.record(z.string(), z.number()).optional(),
    confidence: z.number().optional()
  })
  .strict()

const OpenRouterNoulAnswerSchema = z
  .object({
    type: z.literal('noul'),
    noul: z.number()
  })
  .strict()

export const OpenRouterAnswerSchema = z.discriminatedUnion('type', [
  OpenRouterChoiceAnswerSchema,
  OpenRouterScoreAnswerSchema,
  OpenRouterNoulAnswerSchema
])

function hasSameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key))
}

function isDistribution(probabilities: Record<string, number>): boolean {
  const values = Object.values(probabilities)
  if (values.length === 0) {
    return false
  }
  const total = values.reduce((sum, probability) => sum + probability, 0)
  return Math.abs(total - 1) <= DISTRIBUTION_TOLERANCE
}

function validateChoiceAnswer(
  answer: Extract<JudgmentAnswer, { type: 'choice' }>,
  question: Extract<JudgmentQuestion, { type: 'choice' }>
): JudgmentUnavailableReason | undefined {
  if (!hasSameKeys(answer.probabilities, question.criteria)) {
    return 'probability-keys'
  }
  if (!Object.hasOwn(question.criteria, answer.choice)) {
    return 'choice-invalid'
  }
  if (!isDistribution(answer.probabilities)) {
    return 'probability-distribution'
  }
  const selectedProbability = answer.probabilities[answer.choice]
  if (
    !Object.values(answer.probabilities).every((probability) => selectedProbability >= probability)
  ) {
    return 'choice-not-max'
  }
  return undefined
}

function validateScoreAnswer(
  answer: Extract<JudgmentAnswer, { type: 'score' }>,
  question: Extract<JudgmentQuestion, { type: 'score' }>
): JudgmentUnavailableReason | undefined {
  const expectedLegend = Object.fromEntries(
    question.criteria.map((description, index) => [String(index), description])
  )
  if (
    !hasSameKeys(answer.legend, expectedLegend) ||
    !Object.entries(expectedLegend).every(
      ([level, description]) => answer.legend[level] === description
    )
  ) {
    return 'score-legend'
  }
  if (!hasSameKeys(answer.probabilities, expectedLegend)) {
    return 'probability-keys'
  }
  if (!isDistribution(answer.probabilities)) {
    return 'probability-distribution'
  }
  if (answer.score < 0 || answer.score > question.criteria.length - 1) {
    return 'score-range'
  }
  const weightedScore = Object.entries(answer.probabilities).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0
  )
  return Math.abs(answer.score - weightedScore) <= DISTRIBUTION_TOLERANCE
    ? undefined
    : 'score-weight-mismatch'
}

type JudgmentAnswerParseResult =
  | { answer: JudgmentAnswer }
  | { unavailable: JudgmentUnavailableReason }

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true
  })
}

function parseQuestionAnswer(
  provider: JudgmentProvider,
  rawAnswer: unknown,
  question: JudgmentQuestion
): JudgmentAnswerParseResult {
  if (typeof rawAnswer !== 'object' || rawAnswer === null || Array.isArray(rawAnswer)) {
    return { unavailable: 'answer-shape' }
  }

  const shape = OpenRouterAnswerSchema.safeParse(rawAnswer)
  if (!shape.success) {
    return { unavailable: 'answer-shape' }
  }
  const transportAnswer = shape.data
  if (transportAnswer.type !== question.type) {
    return { unavailable: 'answer-type' }
  }

  if (transportAnswer.type === 'choice' || transportAnswer.type === 'score') {
    if (transportAnswer.confidence === undefined) {
      return { unavailable: 'missing-confidence' }
    }
    if (transportAnswer.probabilities === undefined) {
      return { unavailable: 'missing-probabilities' }
    }
  }

  let candidate: unknown = transportAnswer
  if (transportAnswer.type === 'score') {
    if (question.type !== 'score') {
      return { unavailable: 'answer-type' }
    }
    if (provider === 'typesafe' && transportAnswer.legend === undefined) {
      return { unavailable: 'answer-shape' }
    }
    if (provider === 'openrouter' && transportAnswer.legend === undefined) {
      candidate = {
        ...transportAnswer,
        // The rubric deterministically defines the legend; it is not model output.
        legend: Object.fromEntries(
          question.criteria.map((description, index) => [String(index), description])
        )
      }
    }
  }

  const parsed = JudgmentAnswerSchema.safeParse(candidate)
  if (!parsed.success) {
    return { unavailable: 'answer-shape' }
  }

  const answer = parsed.data
  if (answer.type === 'choice' && question.type === 'choice') {
    const failure = validateChoiceAnswer(answer, question)
    return failure === undefined ? { answer } : { unavailable: failure }
  }
  if (answer.type === 'score' && question.type === 'score') {
    const failure = validateScoreAnswer(answer, question)
    return failure === undefined ? { answer } : { unavailable: failure }
  }
  if (answer.type === 'noul' && question.type === 'noul') {
    return { answer }
  }
  return { unavailable: 'answer-type' }
}

export function normalizeAnswers(
  provider: JudgmentProvider,
  answers: Record<string, unknown>,
  questions: Record<string, JudgmentQuestion>
): {
  answers: Record<string, JudgmentAnswer>
  unavailable?: Record<string, JudgmentUnavailableReason>
} {
  const normalized: Record<string, JudgmentAnswer> = {}
  const unavailable: Record<string, JudgmentUnavailableReason> = {}

  let hasUnavailable = false

  for (const id in questions) {
    if (!Object.hasOwn(questions, id)) {
      continue
    }
    const question = questions[id]
    if (question === undefined) {
      continue
    }
    if (!Object.hasOwn(answers, id)) {
      setOwnRecordValue(unavailable, id, 'missing-answer')
      hasUnavailable = true
      continue
    }

    const result = parseQuestionAnswer(provider, answers[id], question)
    if ('answer' in result) {
      setOwnRecordValue(normalized, id, result.answer)
    } else {
      setOwnRecordValue(unavailable, id, result.unavailable)
      hasUnavailable = true
    }
  }

  return hasUnavailable ? { answers: normalized, unavailable } : { answers: normalized }
}
