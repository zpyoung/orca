import { describe, expect, it } from 'vitest'
import {
  KindAgnosticInterventionSchema,
  OWNER_INTERVENTION_ID_MAX_LENGTH,
  OWNER_INTERVENTION_TEXT_MAX_LENGTH
} from './intervention'

describe('kind-agnostic owner intervention text bounds', () => {
  it.each([
    ['ask-human', 'question', { kind: 'ask-human' }],
    ['abandon', 'rationale', { kind: 'abandon' }],
    ['answer-worker', 'answer', { kind: 'answer-worker', messageId: 'message-1' }],
    ['stop-worker', 'rationale', { kind: 'stop-worker', dispatchId: 'dispatch-1' }]
  ] as const)('accepts %s text at the code-unit cap and rejects +1', (_kind, field, base) => {
    const atLimit = '界'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH)

    expect(atLimit.length).toBe(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    expect(Buffer.byteLength(atLimit, 'utf8')).toBeGreaterThan(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    expect(KindAgnosticInterventionSchema.safeParse({ ...base, [field]: atLimit }).success).toBe(
      true
    )
    expect(
      KindAgnosticInterventionSchema.safeParse({ ...base, [field]: `${atLimit}界` }).success
    ).toBe(false)
  })

  it('accepts messageId at its published cap and rejects +1', () => {
    const messageId = 'm'.repeat(OWNER_INTERVENTION_ID_MAX_LENGTH)

    expect(
      KindAgnosticInterventionSchema.safeParse({
        kind: 'answer-worker',
        messageId,
        answer: 'continue'
      }).success
    ).toBe(true)
    expect(
      KindAgnosticInterventionSchema.safeParse({
        kind: 'answer-worker',
        messageId: `${messageId}m`,
        answer: 'continue'
      }).success
    ).toBe(false)
  })

  it('requires a bounded dispatch id for targeted worker stops', () => {
    const dispatchId = 'd'.repeat(OWNER_INTERVENTION_ID_MAX_LENGTH)
    expect(
      KindAgnosticInterventionSchema.safeParse({
        kind: 'stop-worker',
        dispatchId,
        rationale: 'The worker is stalled'
      }).success
    ).toBe(true)
    expect(
      KindAgnosticInterventionSchema.safeParse({
        kind: 'stop-worker',
        dispatchId: `${dispatchId}d`,
        rationale: 'The worker is stalled'
      }).success
    ).toBe(false)
  })
})
