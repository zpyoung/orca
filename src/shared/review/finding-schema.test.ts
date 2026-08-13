import { describe, expect, it } from 'vitest'
import {
  EvidenceSchema,
  FindingCategorySchema,
  FindingIdFieldSchema,
  FindingIdSchema,
  FindingSchema
} from './finding-schema'

describe('finding id shape', () => {
  it.each(['F1', 'F12', 'F999'])('accepts %s', (id) => {
    expect(FindingIdSchema.safeParse(id).success).toBe(true)
  })

  it.each(['F0', 'F01', 'F', 'G1', '', 'f1', 'F1a'])('rejects %s', (id) => {
    expect(FindingIdSchema.safeParse(id).success).toBe(false)
  })

  it('accepts the longest allowed id', () => {
    expect(FindingIdSchema.safeParse(`F${'9'.repeat(19)}`).success).toBe(true)
  })

  it('rejects an id one character past the length cap', () => {
    expect(FindingIdSchema.safeParse(`F${'9'.repeat(20)}`).success).toBe(false)
  })

  it('rejects an 8,000,001-character id without throwing, quickly', () => {
    const huge = `F${'9'.repeat(8_000_000)}`
    const start = Date.now()
    const result = FindingIdSchema.safeParse(huge)
    expect(result.success).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('finding id field (tolerates pre-assignment)', () => {
  it.each([null, undefined, ''])('accepts %s as not yet assigned', (id) => {
    expect(FindingIdFieldSchema.safeParse(id).success).toBe(true)
  })

  it.each(['F1', 'F12'])('accepts a validly assigned id %s', (id) => {
    expect(FindingIdFieldSchema.safeParse(id).success).toBe(true)
  })

  it.each(['F0', 'Fx', '1', 'F01'])('rejects a malformed non-null id %s', (id) => {
    expect(FindingIdFieldSchema.safeParse(id).success).toBe(false)
  })
})

describe('finding category shape', () => {
  it.each(['failing-check', 'a', 'unresolvable-reference', 'a1-b2'])('accepts %s', (category) => {
    expect(FindingCategorySchema.safeParse(category).success).toBe(true)
  })

  it('accepts exactly 40 characters', () => {
    expect(FindingCategorySchema.safeParse('a'.repeat(40)).success).toBe(true)
  })

  it('rejects 41 characters', () => {
    expect(FindingCategorySchema.safeParse('a'.repeat(41)).success).toBe(false)
  })

  it('rejects an 8,000,001-character category without throwing, quickly', () => {
    const huge = `${'a-'.repeat(4_000_000)}-`
    const start = Date.now()
    const result = FindingCategorySchema.safeParse(huge)
    expect(result.success).toBe(false)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it.each(['', 'Has-Caps', '-leading-hyphen', 'trailing-hyphen-', 'double--hyphen', 'has space'])(
    'rejects %s',
    (category) => {
      expect(FindingCategorySchema.safeParse(category).success).toBe(false)
    }
  )
})

describe('evidence kinds', () => {
  it('file-line requires a non-blank ref and quote', () => {
    expect(EvidenceSchema.safeParse({ kind: 'file-line', ref: 'a.ts:1', quote: 'x' }).success).toBe(
      true
    )
    expect(EvidenceSchema.safeParse({ kind: 'file-line', ref: 'a.ts:1' }).success).toBe(false)
    expect(EvidenceSchema.safeParse({ kind: 'file-line', ref: '  ', quote: 'x' }).success).toBe(
      false
    )
  })

  it('quote requires a non-blank ref and quote', () => {
    expect(EvidenceSchema.safeParse({ kind: 'quote', ref: 'spec#3', quote: 'x' }).success).toBe(true)
    expect(EvidenceSchema.safeParse({ kind: 'quote', quote: 'x' }).success).toBe(false)
  })

  it('command requires a non-blank command and output', () => {
    expect(
      EvidenceSchema.safeParse({ kind: 'command', command: 'pytest -q', output: '1 failed' }).success
    ).toBe(true)
    expect(
      EvidenceSchema.safeParse({ kind: 'command', command: 'pytest -q', output: '' }).success
    ).toBe(false)
    expect(EvidenceSchema.safeParse({ kind: 'command', output: 'x' }).success).toBe(false)
  })

  it('absence requires a non-blank command and ref, but allows empty output as the proof', () => {
    expect(
      EvidenceSchema.safeParse({
        kind: 'absence',
        command: 'git grep -lF token',
        ref: 'token',
        output: ''
      }).success
    ).toBe(true)
    expect(
      EvidenceSchema.safeParse({ kind: 'absence', command: 'git grep -lF token', output: '' }).success
    ).toBe(false)
  })

  it('prepass requires a non-blank ref and output', () => {
    expect(
      EvidenceSchema.safeParse({ kind: 'prepass', ref: 'pnpm test', output: 'exit 1' }).success
    ).toBe(true)
    expect(EvidenceSchema.safeParse({ kind: 'prepass', ref: 'pnpm test', output: '' }).success).toBe(
      false
    )
  })

  it('rejects an unknown kind', () => {
    expect(EvidenceSchema.safeParse({ kind: 'screenshot', ref: 'x', output: 'y' }).success).toBe(
      false
    )
  })
})

describe('Finding round trip', () => {
  const promoteFinding = {
    id: 'F1',
    severity: 'HIGH',
    confidence: 'MEDIUM',
    category: 'unresolvable-reference',
    claim: 'The document names a symbol that does not resolve: foo()',
    evidence: [{ kind: 'absence', command: 'git grep -lF foo(', ref: 'foo(', output: '' }],
    remediation: 'Confirm whether foo() should exist.',
    patch: null,
    stage: 'promote',
    disposition: 'standing',
    kind: 'finding'
  }

  it('parses a representative promote-stage finding', () => {
    expect(FindingSchema.parse(promoteFinding)).toMatchObject(promoteFinding)
  })

  it('parses a promote finding whose id is not yet assigned (null)', () => {
    expect(FindingSchema.safeParse({ ...promoteFinding, id: null }).success).toBe(true)
  })

  it('parses a promote finding whose id is absent', () => {
    const { id: _id, ...withoutId } = promoteFinding
    expect(FindingSchema.safeParse(withoutId).success).toBe(true)
  })

  it('parses a gate-graded finding carrying prior_id and the computed fields', () => {
    const gated = {
      severity: 'MEDIUM',
      confidence: 'LOW',
      category: 'failing-check',
      claim: 'pnpm test fails.',
      evidence: [{ kind: 'prepass', ref: 'pnpm test', output: 'exit 1' }],
      remediation: 'Make the check pass.',
      stage: 'prepass',
      prior_id: 'F2',
      effective_severity: 'MEDIUM',
      blocking: true
    }
    expect(FindingSchema.safeParse(gated).success).toBe(true)
  })

  it('tolerates an unknown field for forward compatibility', () => {
    expect(FindingSchema.safeParse({ ...promoteFinding, futureField: 'x' }).success).toBe(true)
  })

  it('rejects a finding missing required fields', () => {
    expect(FindingSchema.safeParse({ severity: 'HIGH' }).success).toBe(false)
  })

  it('rejects an empty evidence array', () => {
    expect(FindingSchema.safeParse({ ...promoteFinding, evidence: [] }).success).toBe(false)
  })
})
