import { describe, expect, it } from 'vitest'
import { DeviationSchema, deviationNaturalKey, ownerDeviationEscalationId } from './deviation'

const PIPELINE_DEVIATION = {
  kind: 'pipeline-node',
  nodeInstanceId: 'fix',
  epoch: 0,
  attempt: 2,
  cause: 'retries-exhausted',
  options: ['retry', 'skip', 'abort'],
  detail: 'The node exhausted its retries'
} as const

describe('pipeline-node deviation', () => {
  it('accepts the pipeline node fields and derives its stable escalation key', () => {
    const parsed = DeviationSchema.parse(PIPELINE_DEVIATION)
    expect(parsed).toEqual(PIPELINE_DEVIATION)
    expect(deviationNaturalKey(parsed)).toBe('pipeline-node:fix:0:2:retries-exhausted')
    expect(ownerDeviationEscalationId('w1', parsed)).toBe(
      'owner-deviation:w1:pipeline-node:fix:0:2:retries-exhausted'
    )
  })

  it('gives each time-limit deadline a fresh escalation identity', () => {
    const first = DeviationSchema.parse({
      ...PIPELINE_DEVIATION,
      cause: 'time-limit',
      options: ['extend', 'retry', 'skip', 'abort'],
      deadlineMs: 60_000
    })
    const extended = DeviationSchema.parse({ ...first, deadlineMs: 90_000 })
    const recurring = DeviationSchema.parse({ ...first })

    expect(ownerDeviationEscalationId('w1', first)).not.toBe(
      ownerDeviationEscalationId('w1', extended)
    )
    expect(ownerDeviationEscalationId('w1', first)).toBe(
      ownerDeviationEscalationId('w1', recurring)
    )
    const nonTimeLimitWithDeadline = DeviationSchema.parse({
      ...PIPELINE_DEVIATION,
      deadlineMs: 60_000
    })
    expect(deviationNaturalKey(nonTimeLimitWithDeadline)).toBe(
      'pipeline-node:fix:0:2:retries-exhausted'
    )
  })

  it.each([-1, 1.5])('rejects invalid pipeline-node deadlines %s', (deadlineMs) => {
    expect(DeviationSchema.safeParse({ ...PIPELINE_DEVIATION, deadlineMs }).success).toBe(false)
  })

  it('rejects an unknown cause, oversized detail, or extra fields', () => {
    expect(DeviationSchema.safeParse({ ...PIPELINE_DEVIATION, cause: 'unknown' }).success).toBe(
      false
    )
    expect(
      DeviationSchema.safeParse({ ...PIPELINE_DEVIATION, detail: 'x'.repeat(4_001) }).success
    ).toBe(false)
    expect(DeviationSchema.safeParse({ ...PIPELINE_DEVIATION, unexpected: true }).success).toBe(
      false
    )
  })

  it('encodes each natural-key component so delimiters remain unambiguous', () => {
    const parsed = DeviationSchema.parse({ ...PIPELINE_DEVIATION, nodeInstanceId: 'fix/one' })
    expect(deviationNaturalKey(parsed)).toBe('pipeline-node:fix%2Fone:0:2:retries-exhausted')
  })
})
