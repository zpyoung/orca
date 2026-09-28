import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createJudgmentClient,
  JUDGMENT_MAX_REQUEST_BYTES,
  JUDGMENT_MAX_RESPONSE_BYTES,
  JUDGMENT_MAX_STATE_BYTES,
  JudgmentAnswerSchema,
  JudgmentClientFailure,
  JudgmentResponseSchema,
  type JudgmentFetch,
  type JudgmentQuestion
} from './client'

const API_KEY = 'secret-api-key'
const QUESTIONS = {
  route: {
    type: 'choice',
    instructions: 'Which route should handle this?',
    criteria: { automatic: 'Safe to automate', human: 'Needs human review' }
  },
  severity: {
    type: 'score',
    instructions: 'How severe is this?',
    criteria: ['Low', 'Medium', 'High']
  },
  urgent: {
    type: 'noul',
    instructions: 'Is this urgent?'
  }
} satisfies Record<string, JudgmentQuestion>

type VendorAnswerFixture = {
  type: 'choice' | 'score' | 'noul'
  choice?: string
  score?: number
  noul?: number
  legend?: Record<string, string>
  probabilities?: Record<string, number>
  confidence?: number
}

type VendorResponseFixture = {
  model: string
  answers: Record<string, VendorAnswerFixture>
  usage: { input_tokens: number; output_tokens: number }
}

type OpenRouterResponseFixture = {
  id: string
  provider: string
  model: string
  answers: Record<string, VendorAnswerFixture>
  usage: { input_tokens: number; output_tokens: number; cost?: number }
}

function validVendorResponse(): VendorResponseFixture {
  return {
    model: 'jev-2026-09-18',
    answers: {
      route: {
        type: 'choice',
        choice: 'automatic',
        probabilities: { automatic: 0.8, human: 0.2 },
        confidence: 0.75
      },
      severity: {
        type: 'score',
        score: 1.25,
        legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
        probabilities: { '0': 0.1, '1': 0.55, '2': 0.35 },
        confidence: 0.6
      },
      urgent: { type: 'noul', noul: 0.91 }
    },
    usage: { input_tokens: 120, output_tokens: 24 }
  }
}

function validOpenRouterResponse(): OpenRouterResponseFixture {
  const response = validVendorResponse()
  const answers = response.answers
  delete answers.severity.legend
  return {
    id: 'decision-123',
    provider: 'TypeSafe',
    ...response,
    usage: { input_tokens: 120, output_tokens: 24, cost: 0.0042 }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function clientFailure(request: Promise<unknown>): Promise<JudgmentClientFailure> {
  try {
    await request
  } catch (error) {
    expect(error).toBeInstanceOf(JudgmentClientFailure)
    if (error instanceof JudgmentClientFailure) {
      return error
    }
  }
  throw new Error('Expected judgment client to reject')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('judgment client', () => {
  it('does no network work until evaluate and returns the exact resolved model version', async () => {
    const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(validVendorResponse()))
    const client = createJudgmentClient(API_KEY, { fetch: fetcher })

    expect(fetcher).not.toHaveBeenCalled()
    await expect(client.evaluate({ ticket: 'payment failed' }, QUESTIONS)).resolves.toEqual({
      model: 'jev-2026-09-18',
      answers: validVendorResponse().answers
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'jev-latest',
      state: { ticket: 'payment failed' },
      questions: QUESTIONS
    })
  })

  it('isolates OpenRouter URL, model, and key while accepting response metadata', async () => {
    const openRouterKey = 'openrouter-secret-key'
    const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(validOpenRouterResponse()))
    const client = createJudgmentClient(openRouterKey, {
      provider: 'openrouter',
      fetch: fetcher
    })

    expect(fetcher).not.toHaveBeenCalled()
    await expect(client.evaluate({ ticket: 'payment failed' }, QUESTIONS)).resolves.toEqual({
      model: 'jev-2026-09-18',
      answers: validVendorResponse().answers
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(url).not.toBe('https://api.typesafe.ai/v1/systemone')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${openRouterKey}`,
      'Content-Type': 'application/json'
    })
    expect(JSON.parse(String(init.body))).toEqual({
      model: '~typesafe/jev-latest',
      state: { ticket: 'payment failed' },
      questions: QUESTIONS
    })
    expect(String(init.body)).not.toContain(openRouterKey)
  })

  it('refuses OpenRouter choice and score answers missing real confidence or probabilities', async () => {
    const missingFields = [
      ['route', 'confidence'],
      ['route', 'probabilities'],
      ['severity', 'confidence'],
      ['severity', 'probabilities']
    ] as const

    for (const [answerId, field] of missingFields) {
      const payload = validOpenRouterResponse()
      const answer = payload.answers[answerId]
      delete answer[field]
      const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
      const error = await clientFailure(
        createJudgmentClient(API_KEY, { provider: 'openrouter', fetch: fetcher }).evaluate(
          'state',
          QUESTIONS
        )
      )
      expect(error.diagnostic).toEqual({ code: 'malformed-response' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('labels OpenRouter failures without exposing credentials or response text', async () => {
    const openRouterKey = 'openrouter-key-that-must-stay-private'
    const fetcher = vi.fn<JudgmentFetch>(
      async () => new Response(`provider echoed ${openRouterKey}`, { status: 500 })
    )
    const error = await clientFailure(
      createJudgmentClient(openRouterKey, {
        provider: 'openrouter',
        fetch: fetcher
      }).evaluate('state', QUESTIONS)
    )

    expect(error.diagnostic).toEqual({ code: 'http-status', status: 500 })
    expect(error.message).not.toContain(openRouterKey)
    expect(error.message).not.toContain('provider echoed')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('classifies malformed provider payload without exposing its body', async () => {
    const providerBody = `malformed response containing ${API_KEY}`
    const fetcher = vi.fn<JudgmentFetch>(async () => new Response(providerBody))
    const error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    )

    expect(error.diagnostic).toEqual({ code: 'malformed-response' })
    expect(error.message).not.toContain(API_KEY)
    expect(error.message).not.toContain(providerBody)
  })

  it('accepts a noul answer without confidence and keeps schemas strict and finite', () => {
    expect(JudgmentAnswerSchema.safeParse({ type: 'noul', noul: 0.5 }).success).toBe(true)
    expect(
      JudgmentAnswerSchema.safeParse({ type: 'noul', noul: 0.5, confidence: 0.8 }).success
    ).toBe(false)
    expect(
      JudgmentAnswerSchema.safeParse({ type: 'noul', noul: Number.POSITIVE_INFINITY }).success
    ).toBe(false)
    expect(
      JudgmentResponseSchema.safeParse({
        model: 'jev-version',
        answers: { urgent: { type: 'noul', noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 }
      }).success
    ).toBe(false)
  })

  it('bounds model stamps and preserves safe resolved versions exactly', () => {
    const answers = { urgent: { type: 'noul' as const, noul: 0.5 } }
    for (const model of ['   ', 'jev-\u0000invalid', 'x'.repeat(257)]) {
      expect(JudgmentResponseSchema.safeParse({ model, answers }).success).toBe(false)
    }

    const model = ' jev-version '
    expect(JudgmentResponseSchema.parse({ model, answers }).model).toBe(model)
  })

  it('retries only 429 and 529 with bounded exponential backoff', async () => {
    const statuses = [429, 529, 200]
    const fetcher = vi.fn<JudgmentFetch>(async () => {
      const status = statuses.shift()
      return status === 200
        ? jsonResponse(validVendorResponse())
        : new Response('untrusted provider error', { status })
    })
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined)

    await expect(
      createJudgmentClient(API_KEY, { fetch: fetcher, sleep }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({ model: 'jev-2026-09-18' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[100], [200]])
  })

  it('stops after three retryable responses', async () => {
    const fetcher = vi.fn<JudgmentFetch>(async () => new Response(null, { status: 429 }))
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined)

    const error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: fetcher, sleep }).evaluate('state', QUESTIONS)
    )
    expect(error.diagnostic).toEqual({
      code: 'retry-exhausted',
      status: 429,
      attempts: 3
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[100], [200]])
  })

  it('does not retry other HTTP or transport failures or expose unsafe error text', async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined)
    const httpFetcher = vi.fn<JudgmentFetch>(
      async () => new Response(`provider echoed ${API_KEY}`, { status: 500 })
    )
    const httpError = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: httpFetcher, sleep }).evaluate('state', QUESTIONS)
    )
    expect(httpError.diagnostic).toEqual({ code: 'http-status', status: 500 })
    expect(httpError.message).not.toContain(API_KEY)
    expect(httpError.message).not.toContain('provider echoed')
    expect(httpFetcher).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()

    const transportFetcher = vi.fn<JudgmentFetch>(async () => {
      throw new Error(`transport exposed ${API_KEY}`)
    })
    const transportError = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: transportFetcher }).evaluate('state', QUESTIONS)
    )
    expect(transportError.diagnostic).toEqual({ code: 'unknown' })
    expect(transportError.message).not.toContain(API_KEY)
    expect(transportFetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects missing and unexpected answers', async () => {
    const missing = validVendorResponse()
    delete missing.answers.urgent
    const unexpected = validVendorResponse()
    unexpected.answers.other = { type: 'noul', noul: 0.5 }

    for (const payload of [missing, unexpected]) {
      const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
      const error = await clientFailure(
        createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
      )
      expect(error.diagnostic).toEqual({ code: 'malformed-response' })
    }
  })

  it('validates choice options and probability distributions against the question', async () => {
    const unknownOption = validVendorResponse()
    unknownOption.answers.route = {
      type: 'choice',
      choice: 'automatic',
      probabilities: { automatic: 0.5, other: 0.5 },
      confidence: 0.4
    }
    const invalidDistribution = validVendorResponse()
    invalidDistribution.answers.route = {
      type: 'choice',
      choice: 'human',
      probabilities: { automatic: 0.8, human: 0.1 },
      confidence: 0.4
    }

    for (const payload of [unknownOption, invalidDistribution]) {
      const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
      const error = await clientFailure(
        createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
      )
      expect(error.diagnostic).toEqual({ code: 'malformed-response' })
    }
  })

  it('validates score levels, legend, distribution, range, and weighted value', async () => {
    const wrongLegend = validVendorResponse()
    wrongLegend.answers.severity = {
      type: 'score',
      score: 1,
      legend: { '0': 'Low', '1': 'Medium', '2': 'Critical' },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
      confidence: 0.7
    }
    const outOfRange = validVendorResponse()
    outOfRange.answers.severity = {
      type: 'score',
      score: 3,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
      confidence: 0.7
    }
    const inconsistentScore = validVendorResponse()
    inconsistentScore.answers.severity = {
      type: 'score',
      score: 0,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0, '1': 0, '2': 1 },
      confidence: 1
    }

    for (const payload of [wrongLegend, outOfRange, inconsistentScore]) {
      const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
      const error = await clientFailure(
        createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
      )
      expect(error.diagnostic).toEqual({ code: 'malformed-response' })
    }
  })

  it('times out the request without surfacing the rejected transport message', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<JudgmentFetch>(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new Error(`aborted with ${API_KEY}`)),
            { once: true }
          )
        })
    )
    const pending = createJudgmentClient(API_KEY, { fetch: fetcher, timeoutMs: 5 }).evaluate(
      'state',
      QUESTIONS
    )
    const rejection = clientFailure(pending)

    await vi.advanceTimersByTimeAsync(5)
    const error = await rejection
    expect(error.diagnostic).toEqual({ code: 'timeout' })
    expect(error.message).not.toContain(API_KEY)
  })

  it('rejects oversized state and request bodies before egress without truncating', async () => {
    const fetcher = vi.fn<JudgmentFetch>()
    const client = createJudgmentClient(API_KEY, { fetch: fetcher })

    const stateError = await clientFailure(
      client.evaluate('x'.repeat(JUDGMENT_MAX_STATE_BYTES), QUESTIONS)
    )
    expect(stateError.diagnostic).toEqual({ code: 'state-size' })
    const requestError = await clientFailure(
      client.evaluate('state', {
        only: {
          type: 'noul',
          instructions: 'x'.repeat(JUDGMENT_MAX_REQUEST_BYTES)
        }
      })
    )
    expect(requestError.diagnostic).toEqual({ code: 'request-size' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a declared oversized response without parsing its body', async () => {
    const fetcher = vi.fn<JudgmentFetch>(
      async () =>
        new Response(`raw ${API_KEY}`, {
          headers: { 'Content-Length': String(JUDGMENT_MAX_RESPONSE_BYTES + 1) }
        })
    )
    const error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    )

    expect(error.diagnostic).toEqual({ code: 'response-size' })
    expect(error.message).not.toContain(API_KEY)
  })

  it('enforces the response limit when content-length is absent', async () => {
    const fetcher = vi.fn<JudgmentFetch>(
      async () => new Response('x'.repeat(JUDGMENT_MAX_RESPONSE_BYTES + 1))
    )

    const error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    )
    expect(error.diagnostic).toEqual({ code: 'response-size' })
  })
})
