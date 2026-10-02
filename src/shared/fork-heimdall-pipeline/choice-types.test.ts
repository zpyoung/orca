import { describe, expect, it } from 'vitest'
import {
  makePipelineNodeEvidenceKey,
  parsePipelineNodeEvidenceKey,
  pipelineChoiceOptions,
  PipelineAnswerAttributionSchema,
  PipelineAnswerEvidenceSchema,
  PipelineChoiceCauseSchema,
  PipelineChoiceSchema,
  type PipelineChoice
} from './choice-types'

const ATTRIBUTION = {
  actor: { user: 'alice', host: 'devbox' },
  surface: 'heimdall-detail',
  atMs: 0
} as const

const SCOPE = {
  actionKind: 'pipeline-apply-choice',
  contentIdentity: 'pipeline:hash',
  evidenceKey: '["node","fix",0,2,"choice:retries-exhausted"]'
} as const

describe('pipelineChoiceOptions', () => {
  it('returns the ordered choices for each cause and configured route', () => {
    const cases: {
      input: Parameters<typeof pipelineChoiceOptions>[0]
      expected: readonly PipelineChoice[]
    }[] = [
      { input: { nodeType: 'gate', cause: 'gate' }, expected: ['approve', 'abort'] },
      {
        input: { nodeType: 'gate', cause: 'gate', gateSendBackTo: 'planner' },
        expected: ['approve', 'send-back', 'abort']
      },
      {
        input: { nodeType: 'agent', cause: 'retries-exhausted' },
        expected: ['retry', 'skip', 'abort']
      },
      {
        input: {
          nodeType: 'agent',
          cause: 'retries-exhausted',
          onFailSendBackTo: 'fix'
        },
        expected: ['retry', 'skip', 'send-back', 'abort']
      },
      {
        input: { nodeType: 'agent', cause: 'time-limit' },
        expected: ['extend', 'retry', 'skip', 'abort']
      },
      {
        input: { nodeType: 'loop', cause: 'loop-escalate' },
        expected: ['accept', 'one-more-round', 'abort']
      },
      {
        input: { nodeType: 'loop', cause: 'loop-max' },
        expected: ['accept', 'one-more-round', 'abort']
      },
      {
        input: { nodeType: 'merge', cause: 'merge-conflict' },
        expected: ['retry', 'skip', 'abort']
      },
      { input: { nodeType: 'swarm', cause: 'swarm-lint' }, expected: ['retry', 'abort'] },
      {
        input: { nodeType: 'agent', cause: 'configuration' },
        expected: ['retry', 'abort']
      },
      {
        input: { nodeType: 'pr-sitter', cause: 'repeated-failure-after-own-fix' },
        expected: ['retry', 'abort']
      }
    ]

    for (const { input, expected } of cases) {
      expect(pipelineChoiceOptions(input)).toEqual(expected)
    }
  })
})

describe('pipeline choice schemas', () => {
  it('accepts only the published choices and causes', () => {
    expect(PipelineChoiceSchema.options).toEqual([
      'approve',
      'send-back',
      'abort',
      'retry',
      'skip',
      'extend',
      'accept',
      'one-more-round'
    ])
    expect(PipelineChoiceCauseSchema.safeParse('repeated-failure-after-own-fix').success).toBe(true)
    expect(PipelineChoiceCauseSchema.safeParse('unknown').success).toBe(false)
  })

  it('enforces attribution and answer evidence bounds and strict object shapes', () => {
    const evidence = {
      approvalEventId: 'approval-1',
      scope: SCOPE,
      choice: 'retry',
      comment: 'Please retry',
      extendMinutes: 1,
      attribution: ATTRIBUTION
    }
    expect(PipelineAnswerAttributionSchema.safeParse(ATTRIBUTION).success).toBe(true)
    const attributionAtLimit = {
      ...ATTRIBUTION,
      actor: { user: 'u'.repeat(128), host: 'h'.repeat(255) }
    }
    expect(PipelineAnswerAttributionSchema.safeParse(attributionAtLimit).success).toBe(true)
    expect(
      PipelineAnswerAttributionSchema.safeParse({
        ...ATTRIBUTION,
        actor: { ...ATTRIBUTION.actor, user: 'u'.repeat(129) }
      }).success
    ).toBe(false)
    expect(
      PipelineAnswerAttributionSchema.safeParse({
        ...ATTRIBUTION,
        actor: { ...ATTRIBUTION.actor, host: 'h'.repeat(256) }
      }).success
    ).toBe(false)
    expect(PipelineAnswerAttributionSchema.safeParse({ ...ATTRIBUTION, atMs: -1 }).success).toBe(
      false
    )
    expect(PipelineAnswerEvidenceSchema.safeParse(evidence).success).toBe(true)
    expect(
      PipelineAnswerEvidenceSchema.safeParse({
        ...evidence,
        comment: 'c'.repeat(4_000),
        extendMinutes: 1_440
      }).success
    ).toBe(true)
    expect(
      PipelineAnswerEvidenceSchema.safeParse({ ...evidence, comment: 'c'.repeat(4_001) }).success
    ).toBe(false)
    expect(
      PipelineAnswerEvidenceSchema.safeParse({ ...evidence, extendMinutes: 1_441 }).success
    ).toBe(false)
    expect(PipelineAnswerEvidenceSchema.safeParse({ ...evidence, extendMinutes: 0 }).success).toBe(
      false
    )
    expect(PipelineAnswerEvidenceSchema.safeParse({ ...evidence, unexpected: true }).success).toBe(
      false
    )
    expect(
      PipelineAnswerEvidenceSchema.safeParse({
        ...evidence,
        scope: { ...SCOPE, unexpected: true }
      }).success
    ).toBe(false)
    const ownerEvidence = {
      ...evidence,
      attribution: { ...ATTRIBUTION, surface: 'owner-agent' as const },
      attemptId: 'attempt-1',
      attemptFingerprint: 'fingerprint-1'
    }
    expect(PipelineAnswerEvidenceSchema.safeParse(ownerEvidence).success).toBe(true)
    expect(
      PipelineAnswerEvidenceSchema.safeParse({
        ...ownerEvidence,
        attemptId: undefined,
        attemptFingerprint: undefined
      }).success
    ).toBe(false)
    expect(
      PipelineAnswerEvidenceSchema.safeParse({
        ...evidence,
        attemptId: 'attempt-1'
      }).success
    ).toBe(false)
  })
})

describe('pipeline node evidence-key codec', () => {
  it('round-trips choice, base node and composite keys', () => {
    const timeLimitKey = JSON.stringify([
      'node',
      'fix',
      1,
      2,
      'choice:time-limit',
      1_700_000_000_000
    ])
    expect(
      parsePipelineNodeEvidenceKey('["node","fix",1,2,"choice:time-limit",1700000000000]')
    ).toEqual({
      instanceId: 'fix',
      epoch: 1,
      attempt: 2,
      cause: 'time-limit',
      deadlineMs: 1_700_000_000_000
    })
    expect(
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 1,
        attempt: 2,
        cause: 'time-limit',
        deadlineMs: 1_700_000_000_000
      })
    ).toBe(timeLimitKey)
    expect(
      parsePipelineNodeEvidenceKey(
        makePipelineNodeEvidenceKey({ instanceId: 'fix', epoch: 0, attempt: 0 })
      )
    ).toEqual({ instanceId: 'fix', epoch: 0, attempt: 0 })
    expect(
      parsePipelineNodeEvidenceKey(
        makePipelineNodeEvidenceKey({
          instanceId: 'sit',
          epoch: 3,
          attempt: 1,
          innerContentIdentity: 'sitter:pin',
          innerEvidenceKey: 'review:head'
        })
      )
    ).toEqual({
      instanceId: 'sit',
      epoch: 3,
      attempt: 1,
      innerContentIdentity: 'sitter:pin',
      innerEvidenceKey: 'review:head'
    })
    const causeNamedInnerKey = makePipelineNodeEvidenceKey({
      instanceId: 'sit',
      epoch: 3,
      attempt: 1,
      innerContentIdentity: 'choice:time-limit',
      innerEvidenceKey: 'review:head'
    })
    expect(parsePipelineNodeEvidenceKey(causeNamedInnerKey)).toEqual({
      instanceId: 'sit',
      epoch: 3,
      attempt: 1,
      innerContentIdentity: 'choice:time-limit',
      innerEvidenceKey: 'review:head'
    })
  })

  it('round-trips native steps and distinguishes child-specific fingerprints', () => {
    const base = { instanceId: 'merge', epoch: 1, attempt: 2 }
    const firstStep = JSON.stringify(['child-a', 'commit-a', 'base-a'])
    const secondStep = JSON.stringify(['child-b', 'commit-b', 'base-a'])
    const sameChildDifferentBase = JSON.stringify(['child-a', 'commit-a', 'base-b'])
    const firstKey = makePipelineNodeEvidenceKey({ ...base, step: firstStep })
    const secondKey = makePipelineNodeEvidenceKey({ ...base, step: secondStep })
    const differentBaseKey = makePipelineNodeEvidenceKey({
      ...base,
      step: sameChildDifferentBase
    })

    expect(firstKey).toBe(JSON.stringify(['node', 'merge', 1, 2, `step:${firstStep}`]))
    expect(parsePipelineNodeEvidenceKey(firstKey)).toEqual({ ...base, step: firstStep })
    expect(firstKey).not.toBe(secondKey)
    expect(firstKey).not.toBe(differentBaseKey)
  })

  it.each([
    'not json',
    '{}',
    '["other","fix",1,2]',
    '["node","fix",-1,2]',
    '["node","fix",1,2,"choice:unknown"]',
    '["node","fix",1,2,"choice:retries-exhausted",10]',
    '["node","fix",1,2,"step:"]',
    '["node","fix",1,2,"step: "]',
    '["node","fix",1,2,"step: ",10]'
  ])('returns null for malformed key %s', (key) => {
    expect(parsePipelineNodeEvidenceKey(key)).toBeNull()
  })

  it('rejects ambiguous key parts rather than emitting an undecodable key', () => {
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        cause: 'gate',
        innerContentIdentity: 'inner',
        innerEvidenceKey: 'key'
      })
    ).toThrow()
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        innerContentIdentity: 'inner'
      })
    ).toThrow()
  })

  it('rejects empty steps and mutually exclusive step qualifiers', () => {
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        step: ''
      })
    ).toThrow()
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        step: ' '
      })
    ).toThrow()
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        step: 'native-step',
        cause: 'gate'
      })
    ).toThrow()
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        step: 'native-step',
        deadlineMs: 60_000
      })
    ).toThrow()
    expect(() =>
      makePipelineNodeEvidenceKey({
        instanceId: 'fix',
        epoch: 0,
        attempt: 1,
        step: 'native-step',
        innerContentIdentity: 'inner',
        innerEvidenceKey: 'key'
      })
    ).toThrow()
  })
})
