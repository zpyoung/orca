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
import { JudgmentUnavailableReasonSchema } from './answer-validation'

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

  it('reports OpenRouter confidence and probability omissions independently while preserving valid answers', async () => {
    const missingFields = [
      ['route', 'confidence', 'missing-confidence'],
      ['route', 'probabilities', 'missing-probabilities'],
      ['severity', 'confidence', 'missing-confidence'],
      ['severity', 'probabilities', 'missing-probabilities']
    ] as const

    for (const [answerId, field, reason] of missingFields) {
      const payload = validOpenRouterResponse()
      const answer = payload.answers[answerId]
      delete answer[field]
      const expectedAnswers = { ...validVendorResponse().answers }
      delete expectedAnswers[answerId]
      const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
      await expect(
        createJudgmentClient(API_KEY, { provider: 'openrouter', fetch: fetcher }).evaluate(
          'state',
          QUESTIONS
        )
      ).resolves.toEqual({
        model: payload.model,
        answers: expectedAnswers,
        unavailable: { [answerId]: reason }
      })
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

  it('classifies invalid JSON without exposing its body or credentials', async () => {
    const providerBody = `malformed response containing ${API_KEY}`
    const fetcher = vi.fn<JudgmentFetch>(async () => new Response(providerBody))
    const error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    )

    expect(error.diagnostic).toEqual({
      code: 'malformed-response',
      reason: 'invalid-json'
    })
    expect(error.message).not.toContain(API_KEY)
    expect(error.message).not.toContain(providerBody)
    expect(JSON.stringify(error.diagnostic)).not.toContain(API_KEY)
  })

  it('returns bounded malformed-response reasons for invalid UTF-8 and invalid envelopes', async () => {
    const invalidUtf8Fetcher = vi.fn<JudgmentFetch>(
      async () => new Response(new Uint8Array([0xc3, 0x28]))
    )
    const utf8Error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: invalidUtf8Fetcher }).evaluate('state', QUESTIONS)
    )
    expect(utf8Error.diagnostic).toEqual({
      code: 'malformed-response',
      reason: 'invalid-utf8'
    })

    const invalidEnvelope = {
      ...validVendorResponse(),
      provider_secret: API_KEY
    }
    const envelopeFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(invalidEnvelope))
    const envelopeError = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: envelopeFetcher }).evaluate('state', QUESTIONS)
    )
    expect(envelopeError.diagnostic).toEqual({
      code: 'malformed-response',
      reason: 'invalid-envelope'
    })
    expect(envelopeError.message).not.toContain(API_KEY)
    expect(JSON.stringify(envelopeError.diagnostic)).not.toContain(API_KEY)

    const invalidModel = validVendorResponse()
    invalidModel.model = `\u0000${API_KEY}`
    const modelFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(invalidModel))
    const modelError = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: modelFetcher }).evaluate('state', QUESTIONS)
    )
    expect(modelError.diagnostic).toEqual({
      code: 'malformed-response',
      reason: 'invalid-envelope'
    })
    expect(modelError.message).not.toContain(API_KEY)
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
        unavailable: { route: 'missing-answer' }
      }).success
    ).toBe(true)
    expect(JudgmentUnavailableReasonSchema.options).toEqual([
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
    expect(
      JudgmentResponseSchema.safeParse({
        model: 'jev-version',
        answers: { urgent: { type: 'noul', noul: 0.5 } },
        unavailable: { route: 'secret-provider-detail' }
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
    expect(transportError.diagnostic).toEqual({ code: 'network-error' })
    expect(transportError.message).not.toContain(API_KEY)
    expect(transportError.message).not.toContain('transport exposed')
    expect(transportFetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves missing answers as unavailable and rejects unexpected answer IDs safely', async () => {
    const missing = validVendorResponse()
    delete missing.answers.urgent
    const missingFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(missing))
    await expect(
      createJudgmentClient(API_KEY, { fetch: missingFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toEqual({
      model: missing.model,
      answers: {
        route: missing.answers.route,
        severity: missing.answers.severity
      },
      unavailable: { urgent: 'missing-answer' }
    })

    const unexpectedId = `private-id-${API_KEY}`
    const unexpected = validVendorResponse()
    unexpected.answers[unexpectedId] = { type: 'noul', noul: 0.5 }
    const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(unexpected))
    const error = await clientFailure(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    )
    expect(error.diagnostic).toEqual({
      code: 'malformed-response',
      reason: 'unexpected-answer'
    })
    expect(error.message).not.toContain(unexpectedId)
    expect(JSON.stringify(error.diagnostic)).not.toContain(unexpectedId)
  })

  it('reports missing TypeSafe confidence and probabilities without discarding other answers', async () => {
    const missingFields = [
      ['route', 'confidence', 'missing-confidence'],
      ['route', 'probabilities', 'missing-probabilities'],
      ['severity', 'confidence', 'missing-confidence'],
      ['severity', 'probabilities', 'missing-probabilities']
    ] as const

    for (const [answerId, field, reason] of missingFields) {
      const payload = validVendorResponse()
      delete payload.answers[answerId][field]
      const expectedAnswers = { ...validVendorResponse().answers }
      delete expectedAnswers[answerId]
      const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
      await expect(
        createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
      ).resolves.toEqual({
        model: payload.model,
        answers: expectedAnswers,
        unavailable: { [answerId]: reason }
      })
    }
  })

  it('reports a weighted score mismatch without discarding valid answers', async () => {
    const payload = validVendorResponse()
    payload.answers.severity = {
      type: 'score',
      score: 0,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0, '1': 0, '2': 1 },
      confidence: 1
    }
    const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(payload))
    await expect(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    ).resolves.toEqual({
      model: payload.model,
      answers: {
        route: payload.answers.route,
        urgent: payload.answers.urgent
      },
      unavailable: { severity: 'score-weight-mismatch' }
    })
  })

  it('distinguishes malformed answer shape from mismatched answer type', async () => {
    const malformed = {
      ...validVendorResponse(),
      answers: { ...validVendorResponse().answers, route: { type: 'choice', choice: 7 } }
    }
    const expectedAnswers = { ...validVendorResponse().answers }
    delete expectedAnswers.route
    const malformedFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(malformed))
    await expect(
      createJudgmentClient(API_KEY, { fetch: malformedFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toEqual({
      model: malformed.model,
      answers: expectedAnswers,
      unavailable: { route: 'answer-shape' }
    })

    const mismatched = validVendorResponse()
    mismatched.answers.route = {
      type: 'score',
      score: 1,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
      confidence: 0.7
    }
    const mismatchFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(mismatched))
    await expect(
      createJudgmentClient(API_KEY, { fetch: mismatchFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toEqual({
      model: mismatched.model,
      answers: expectedAnswers,
      unavailable: { route: 'answer-type' }
    })
  })

  it('rejects unexpected OpenRouter answer IDs without exposing them', async () => {
    const unexpectedId = `private-openrouter-id-${API_KEY}`
    const unexpected = validOpenRouterResponse()
    unexpected.answers[unexpectedId] = { type: 'noul', noul: 0.5 }
    const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(unexpected))
    const error = await clientFailure(
      createJudgmentClient(API_KEY, { provider: 'openrouter', fetch: fetcher }).evaluate(
        'state',
        QUESTIONS
      )
    )

    expect(error.diagnostic).toEqual({
      code: 'malformed-response',
      reason: 'unexpected-answer'
    })
    expect(error.message).not.toContain(unexpectedId)
    expect(JSON.stringify(error.diagnostic)).not.toContain(unexpectedId)
  })

  it('keeps valid answers when individual choice answers are inconsistent', async () => {
    const unknownProbabilityKey = validVendorResponse()
    unknownProbabilityKey.answers.route = {
      type: 'choice',
      choice: 'automatic',
      probabilities: { automatic: 0.5, other: 0.5 },
      confidence: 0.4
    }
    const keyFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(unknownProbabilityKey))
    await expect(
      createJudgmentClient(API_KEY, { fetch: keyFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      answers: { severity: validVendorResponse().answers.severity, urgent: { type: 'noul' } },
      unavailable: { route: 'probability-keys' }
    })

    const invalidDistribution = validVendorResponse()
    invalidDistribution.answers.route = {
      type: 'choice',
      choice: 'human',
      probabilities: { automatic: 0.8, human: 0.1 },
      confidence: 0.4
    }
    const distributionFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(invalidDistribution))
    await expect(
      createJudgmentClient(API_KEY, { fetch: distributionFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      answers: { severity: validVendorResponse().answers.severity, urgent: { type: 'noul' } },
      unavailable: { route: 'probability-distribution' }
    })

    const invalidChoice = validVendorResponse()
    invalidChoice.answers.route = {
      type: 'choice',
      choice: 'unlisted',
      probabilities: { automatic: 0.8, human: 0.2 },
      confidence: 0.4
    }
    const choiceFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(invalidChoice))
    await expect(
      createJudgmentClient(API_KEY, { fetch: choiceFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      answers: { severity: validVendorResponse().answers.severity, urgent: { type: 'noul' } },
      unavailable: { route: 'choice-invalid' }
    })

    const choiceNotMax = validVendorResponse()
    choiceNotMax.answers.route = {
      type: 'choice',
      choice: 'human',
      probabilities: { automatic: 0.8, human: 0.2 },
      confidence: 0.4
    }
    const notMaxFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(choiceNotMax))
    await expect(
      createJudgmentClient(API_KEY, { fetch: notMaxFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      answers: { severity: validVendorResponse().answers.severity, urgent: { type: 'noul' } },
      unavailable: { route: 'choice-not-max' }
    })
  })

  it('keeps valid answers when individual score answers are inconsistent', async () => {
    const wrongLegend = validVendorResponse()
    wrongLegend.answers.severity = {
      type: 'score',
      score: 1,
      legend: { '0': 'Low', '1': 'Medium', '2': 'Critical' },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
      confidence: 0.7
    }

    const fetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(wrongLegend))
    await expect(
      createJudgmentClient(API_KEY, { fetch: fetcher }).evaluate('state', QUESTIONS)
    ).resolves.toEqual({
      model: wrongLegend.model,
      answers: {
        route: wrongLegend.answers.route,
        urgent: wrongLegend.answers.urgent
      },
      unavailable: { severity: 'score-legend' }
    })

    const probabilityKeys = validVendorResponse()
    probabilityKeys.answers.severity = {
      type: 'score',
      score: 1,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0.1, '1': 0.8, '3': 0.1 },
      confidence: 0.7
    }
    const keysFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(probabilityKeys))
    await expect(
      createJudgmentClient(API_KEY, { fetch: keysFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      unavailable: { severity: 'probability-keys' }
    })

    const invalidDistribution = validVendorResponse()
    invalidDistribution.answers.severity = {
      type: 'score',
      score: 1,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.2 },
      confidence: 0.7
    }
    const distributionFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(invalidDistribution))
    await expect(
      createJudgmentClient(API_KEY, { fetch: distributionFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      unavailable: { severity: 'probability-distribution' }
    })

    const outOfRange = validVendorResponse()
    outOfRange.answers.severity = {
      type: 'score',
      score: 3,
      legend: { '0': 'Low', '1': 'Medium', '2': 'High' },
      probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 },
      confidence: 0.7
    }
    const rangeFetcher = vi.fn<JudgmentFetch>(async () => jsonResponse(outOfRange))
    await expect(
      createJudgmentClient(API_KEY, { fetch: rangeFetcher }).evaluate('state', QUESTIONS)
    ).resolves.toMatchObject({
      unavailable: { severity: 'score-range' }
    })
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
