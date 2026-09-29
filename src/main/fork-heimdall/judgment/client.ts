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
import {
  JudgmentUnavailableReasonSchema,
  normalizeAnswers,
  OpenRouterAnswerSchema
} from './answer-validation'
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
    answers: z.record(z.string().min(1), JudgmentAnswerSchema),
    unavailable: z.record(z.string().min(1), JudgmentUnavailableReasonSchema).optional()
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

const JudgmentVendorEnvelopeSchema = JudgmentVendorResponseSchema.extend({
  answers: z.record(z.string(), z.unknown())
}).strict()

const JudgmentOpenRouterEnvelopeSchema = JudgmentOpenRouterResponseSchema.extend({
  answers: z.record(z.string(), z.unknown())
}).strict()

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

export type JudgmentClientFailureDiagnostic =
  | { code: 'timeout' }
  | { code: 'network-error' }
  | { code: 'http-status'; status: number }
  | { code: 'retry-exhausted'; status: number; attempts: number }
  | { code: 'state-size' | 'request-size' | 'response-size' }
  | {
      code: 'malformed-response'
      reason?: 'invalid-json' | 'invalid-utf8' | 'invalid-envelope' | 'unexpected-answer'
    }
  | { code: 'unknown' }

export class JudgmentClientFailure extends Error {
  constructor(
    message: string,
    readonly diagnostic: JudgmentClientFailureDiagnostic = { code: 'unknown' }
  ) {
    super(message)
  }
}

type AttemptResult =
  | { response: JudgmentResponse; status?: never }
  | { response?: never; status: number }

function failure(
  provider: JudgmentProvider,
  message: string,
  diagnostic: JudgmentClientFailureDiagnostic = { code: 'unknown' }
): JudgmentClientFailure {
  return new JudgmentClientFailure(
    `${JUDGMENT_TRANSPORTS[provider].label} judgment ${message}`,
    diagnostic
  )
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
    const serializedBytes = Buffer.byteLength(serialized, 'utf8')
    if (serializedBytes > JUDGMENT_MAX_STATE_BYTES) {
      throw failure(provider, `state exceeds the ${JUDGMENT_MAX_STATE_BYTES}-byte limit`, {
        code: 'state-size'
      })
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
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  if (bodyBytes > JUDGMENT_MAX_REQUEST_BYTES) {
    throw failure(provider, `request exceeds the ${JUDGMENT_MAX_REQUEST_BYTES}-byte limit`, {
      code: 'request-size'
    })
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
    throw failure(provider, `response exceeds the ${JUDGMENT_MAX_RESPONSE_BYTES}-byte limit`, {
      code: 'response-size'
    })
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
      throw failure(provider, `response exceeds the ${JUDGMENT_MAX_RESPONSE_BYTES}-byte limit`, {
        code: 'response-size'
      })
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
    throw failure(provider, 'response is invalid', {
      code: 'malformed-response',
      reason: 'invalid-utf8'
    })
  }
}

function malformedResponse(
  provider: JudgmentProvider,
  reason: NonNullable<
    Extract<JudgmentClientFailureDiagnostic, { code: 'malformed-response' }>['reason']
  >
): JudgmentClientFailure {
  return failure(provider, 'response is invalid', { code: 'malformed-response', reason })
}

async function parseResponse(
  provider: JudgmentProvider,
  response: Response,
  questions: Record<string, JudgmentQuestion>
): Promise<JudgmentResponse> {
  const body = await readBoundedResponse(provider, response)
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw malformedResponse(provider, 'invalid-json')
  }

  const envelope =
    provider === 'typesafe'
      ? JudgmentVendorEnvelopeSchema.safeParse(raw)
      : JudgmentOpenRouterEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    throw malformedResponse(provider, 'invalid-envelope')
  }

  for (const id in envelope.data.answers) {
    if (Object.hasOwn(envelope.data.answers, id) && !Object.hasOwn(questions, id)) {
      throw malformedResponse(provider, 'unexpected-answer')
    }
  }

  return {
    model: envelope.data.model,
    ...normalizeAnswers(provider, envelope.data.answers, questions)
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
          ? failure(provider, 'request timed out', { code: 'timeout' })
          : failure(provider, 'request failed', { code: 'network-error' })
      }

      if (!response.ok) {
        await cancelUnreadResponseBody(response)
        return { status: response.status }
      }
      return { response: await parseResponse(provider, response, questions) }
    } catch (error) {
      if (controller.signal.aborted) {
        throw failure(provider, 'request timed out', { code: 'timeout' })
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
        if (result.status !== 429 && result.status !== 529) {
          throw failure(provider, `request failed with HTTP ${result.status}`, {
            code: 'http-status',
            status: result.status
          })
        }
        if (attempt === MAX_ATTEMPTS - 1) {
          throw failure(provider, `request failed with HTTP ${result.status}`, {
            code: 'retry-exhausted',
            status: result.status,
            attempts: MAX_ATTEMPTS
          })
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
