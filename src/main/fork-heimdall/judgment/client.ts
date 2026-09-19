import { z } from 'zod'
import {
  JudgmentAnswerSchema,
  JudgmentModelSchema,
  JudgmentProviderSchema,
  JudgmentQuestionSchema,
  type JudgmentAnswer,
  type JudgmentProvider,
  type JudgmentQuestion
} from '../../../shared/fork-heimdall/judgment/types'
import { cancelUnreadResponseBody } from '../../lib/unread-response-body'
import { getMainHttpClient } from '../../network/http-client'

const JUDGMENT_TRANSPORTS: Record<JudgmentProvider, { url: string; model: string; label: string }> =
  {
    typesafe: {
      url: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      label: 'TypeSafe'
    },
    openrouter: {
      url: 'https://openrouter.ai/api/alpha/decisions',
      model: '~typesafe/jev-latest',
      label: 'OpenRouter'
    }
  }
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 100
const DISTRIBUTION_TOLERANCE = 1e-6

export const JUDGMENT_MAX_STATE_BYTES = 32 * 1024
export const JUDGMENT_MAX_REQUEST_BYTES = 256 * 1024
export const JUDGMENT_MAX_RESPONSE_BYTES = 1024 * 1024
export const JUDGMENT_REQUEST_TIMEOUT_MS = 5_000

const JudgmentQuestionsSchema = z
  .record(z.string().trim().min(1), JudgmentQuestionSchema)
  .refine((questions) => Object.keys(questions).length > 0, 'At least one question is required')

export { JudgmentAnswerSchema, JudgmentModelSchema, JudgmentQuestionSchema }
export type { JudgmentAnswer, JudgmentProvider, JudgmentQuestion }
export const JudgmentResponseSchema = z
  .object({
    model: JudgmentModelSchema,
    answers: z.record(z.string().min(1), JudgmentAnswerSchema)
  })
  .strict()

export const JudgmentVendorResponseSchema = z
  .object({
    model: JudgmentModelSchema,
    answers: z.record(z.string().min(1), JudgmentAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()

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

const OpenRouterAnswerSchema = z.discriminatedUnion('type', [
  OpenRouterChoiceAnswerSchema,
  OpenRouterScoreAnswerSchema,
  OpenRouterNoulAnswerSchema
])

export const JudgmentOpenRouterResponseSchema = z
  .object({
    id: z.string().optional(),
    model: JudgmentModelSchema,
    provider: z.string().optional(),
    answers: z.record(z.string().min(1), OpenRouterAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cost: z.number().finite().nonnegative().optional()
      })
      .strict()
  })
  .strict()

export type JudgmentResponse = z.infer<typeof JudgmentResponseSchema>

export type JudgmentClient = {
  evaluate(state: unknown, questions: Record<string, JudgmentQuestion>): Promise<JudgmentResponse>
}

export type JudgmentFetch = (url: string, init: RequestInit) => Promise<Response>

export type JudgmentClientOptions = {
  provider?: JudgmentProvider
  fetch?: JudgmentFetch
  sleep?: (milliseconds: number) => Promise<void>
  timeoutMs?: number
}

class JudgmentClientFailure extends Error {}

type AttemptResult =
  | { response: JudgmentResponse; status?: never }
  | { response?: never; status: number }

function failure(provider: JudgmentProvider, message: string): JudgmentClientFailure {
  return new JudgmentClientFailure(`${JUDGMENT_TRANSPORTS[provider].label} judgment ${message}`)
}

type SerializedRequest = {
  body: string
  questions: Record<string, JudgmentQuestion>
}

function serializeState(provider: JudgmentProvider, state: unknown): string {
  if (state === null || (typeof state !== 'string' && typeof state !== 'object')) {
    throw failure(provider, 'state is invalid')
  }
  try {
    const serialized = JSON.stringify(state)
    if (serialized === undefined) {
      throw failure(provider, 'state is invalid')
    }
    if (Buffer.byteLength(serialized, 'utf8') > JUDGMENT_MAX_STATE_BYTES) {
      throw failure(provider, `state exceeds the ${JUDGMENT_MAX_STATE_BYTES}-byte limit`)
    }
    return serialized
  } catch (error) {
    if (error instanceof JudgmentClientFailure) {
      throw error
    }
    throw failure(provider, 'state is invalid')
  }
}

function serializeRequest(
  provider: JudgmentProvider,
  state: unknown,
  questions: Record<string, JudgmentQuestion>
): SerializedRequest {
  let parsedQuestions: Record<string, JudgmentQuestion>
  try {
    parsedQuestions = JudgmentQuestionsSchema.parse(questions)
  } catch {
    throw failure(provider, 'questions are invalid')
  }

  const stateJson = serializeState(provider, state)
  const questionsJson = JSON.stringify(parsedQuestions)
  const modelJson = JSON.stringify(JUDGMENT_TRANSPORTS[provider].model)
  const body = `{"model":${modelJson},"state":${stateJson},"questions":${questionsJson}}`
  if (Buffer.byteLength(body, 'utf8') > JUDGMENT_MAX_REQUEST_BYTES) {
    throw failure(provider, `request exceeds the ${JUDGMENT_MAX_REQUEST_BYTES}-byte limit`)
  }
  return { body, questions: parsedQuestions }
}

export function judgmentRequestFitsTransportLimits(
  provider: JudgmentProvider,
  state: unknown,
  questions: Record<string, JudgmentQuestion>
): boolean {
  try {
    serializeRequest(provider, state, questions)
    return true
  } catch {
    return false
  }
}

async function readBoundedResponse(
  provider: JudgmentProvider,
  response: Response
): Promise<string> {
  const declaredBytes = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredBytes) && declaredBytes > JUDGMENT_MAX_RESPONSE_BYTES) {
    await cancelUnreadResponseBody(response)
    throw failure(provider, `response exceeds the ${JUDGMENT_MAX_RESPONSE_BYTES}-byte limit`)
  }
  if (!response.body) {
    return ''
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    totalBytes += chunk.value.byteLength
    if (totalBytes > JUDGMENT_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw failure(provider, `response exceeds the ${JUDGMENT_MAX_RESPONSE_BYTES}-byte limit`)
    }
    chunks.push(chunk.value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw failure(provider, 'response is invalid')
  }
}

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

function isChoiceAnswerValid(
  answer: Extract<JudgmentAnswer, { type: 'choice' }>,
  question: Extract<JudgmentQuestion, { type: 'choice' }>
): boolean {
  if (
    !hasSameKeys(answer.probabilities, question.criteria) ||
    !Object.hasOwn(question.criteria, answer.choice) ||
    !isDistribution(answer.probabilities)
  ) {
    return false
  }
  const selectedProbability = answer.probabilities[answer.choice]
  return Object.values(answer.probabilities).every(
    (probability) => selectedProbability >= probability
  )
}

function isScoreAnswerValid(
  answer: Extract<JudgmentAnswer, { type: 'score' }>,
  question: Extract<JudgmentQuestion, { type: 'score' }>
): boolean {
  const expectedLegend = Object.fromEntries(
    question.criteria.map((description, index) => [String(index), description])
  )
  if (
    !hasSameKeys(answer.legend, expectedLegend) ||
    !hasSameKeys(answer.probabilities, expectedLegend) ||
    !Object.entries(expectedLegend).every(
      ([level, description]) => answer.legend[level] === description
    ) ||
    !isDistribution(answer.probabilities)
  ) {
    return false
  }
  if (answer.score < 0 || answer.score > question.criteria.length - 1) {
    return false
  }
  const weightedScore = Object.entries(answer.probabilities).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0
  )
  return Math.abs(answer.score - weightedScore) <= DISTRIBUTION_TOLERANCE
}

function answersMatchQuestions(
  answers: Record<string, JudgmentAnswer>,
  questions: Record<string, JudgmentQuestion>
): boolean {
  if (!hasSameKeys(answers, questions)) {
    return false
  }
  return Object.entries(questions).every(([id, question]) => {
    const answer = answers[id]
    if (!answer || answer.type !== question.type) {
      return false
    }
    if (answer.type === 'choice' && question.type === 'choice') {
      return isChoiceAnswerValid(answer, question)
    }
    if (answer.type === 'score' && question.type === 'score') {
      return isScoreAnswerValid(answer, question)
    }
    return answer.type === 'noul' && question.type === 'noul'
  })
}

function normalizeOpenRouterAnswers(
  answers: z.infer<typeof JudgmentOpenRouterResponseSchema>['answers'],
  questions: Record<string, JudgmentQuestion>
): Record<string, JudgmentAnswer> | null {
  if (!hasSameKeys(answers, questions)) {
    return null
  }
  const normalized: Record<string, JudgmentAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id]
    if (!answer || answer.type !== question.type) {
      return null
    }

    let candidate: unknown
    if (answer.type === 'choice' && question.type === 'choice') {
      if (answer.confidence === undefined || answer.probabilities === undefined) {
        return null
      }
      candidate = answer
    } else if (answer.type === 'score' && question.type === 'score') {
      if (answer.confidence === undefined || answer.probabilities === undefined) {
        return null
      }
      // The score rubric deterministically defines the numeric legend, so an omitted
      // transport legend can be restored without inventing model output.
      candidate = {
        ...answer,
        legend:
          answer.legend ??
          Object.fromEntries(
            question.criteria.map((description, index) => [String(index), description])
          )
      }
    } else if (answer.type === 'noul' && question.type === 'noul') {
      candidate = answer
    } else {
      return null
    }

    const parsed = JudgmentAnswerSchema.safeParse(candidate)
    if (!parsed.success) {
      return null
    }
    normalized[id] = parsed.data
  }
  return normalized
}

async function parseResponse(
  provider: JudgmentProvider,
  response: Response,
  questions: Record<string, JudgmentQuestion>
): Promise<JudgmentResponse> {
  let raw: unknown
  try {
    raw = JSON.parse(await readBoundedResponse(provider, response))
  } catch (error) {
    if (error instanceof JudgmentClientFailure) {
      throw error
    }
    throw failure(provider, 'response is invalid')
  }

  try {
    if (provider === 'typesafe') {
      const parsed = JudgmentVendorResponseSchema.parse(raw)
      if (!answersMatchQuestions(parsed.answers, questions)) {
        throw failure(provider, 'response is invalid')
      }
      return { model: parsed.model, answers: parsed.answers }
    }

    const parsed = JudgmentOpenRouterResponseSchema.parse(raw)
    const answers = normalizeOpenRouterAnswers(parsed.answers, questions)
    if (answers === null || !answersMatchQuestions(answers, questions)) {
      throw failure(provider, 'response is invalid')
    }
    return { model: parsed.model, answers }
  } catch (error) {
    if (error instanceof JudgmentClientFailure) {
      throw error
    }
    throw failure(provider, 'response is invalid')
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

const defaultFetch: JudgmentFetch = (url, init) => getMainHttpClient().fetch(url, init)

export function createJudgmentClient(
  apiKey: string,
  options: JudgmentClientOptions = {}
): JudgmentClient {
  const parsedProvider = JudgmentProviderSchema.safeParse(options.provider ?? 'typesafe')
  if (!parsedProvider.success) {
    throw new JudgmentClientFailure('Judgment provider is invalid')
  }
  const provider = parsedProvider.data
  const transport = JUDGMENT_TRANSPORTS[provider]
  if (!apiKey.trim()) {
    throw failure(provider, 'API key is invalid')
  }
  const fetcher = options.fetch ?? defaultFetch
  const sleep = options.sleep ?? defaultSleep
  const timeoutMs = options.timeoutMs ?? JUDGMENT_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw failure(provider, 'timeout is invalid')
  }

  const requestOnce = async (
    body: string,
    questions: Record<string, JudgmentQuestion>
  ): Promise<AttemptResult> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await fetcher(transport.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body,
          signal: controller.signal
        })
      } catch {
        throw controller.signal.aborted
          ? failure(provider, 'request timed out')
          : failure(provider, 'request failed')
      }

      if (!response.ok) {
        await cancelUnreadResponseBody(response)
        return { status: response.status }
      }
      return { response: await parseResponse(provider, response, questions) }
    } catch (error) {
      if (controller.signal.aborted) {
        throw failure(provider, 'request timed out')
      }
      if (error instanceof JudgmentClientFailure) {
        throw error
      }
      throw failure(provider, 'response is invalid')
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async evaluate(state, questions): Promise<JudgmentResponse> {
      const request = serializeRequest(provider, state, questions)
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const result = await requestOnce(request.body, request.questions)
        if (result.response) {
          return result.response
        }
        if ((result.status !== 429 && result.status !== 529) || attempt === MAX_ATTEMPTS - 1) {
          throw failure(provider, `request failed with HTTP ${result.status}`)
        }
        try {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
        } catch {
          throw failure(provider, 'retry wait failed')
        }
      }
      throw failure(provider, 'request failed')
    }
  }
}
