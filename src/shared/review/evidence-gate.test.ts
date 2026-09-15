import { describe, expect, it } from 'vitest'
import type { Finding } from './finding-schema'
import { applyEvidenceGate, evaluateEvidenceGate } from './evidence-gate'

const chain = {
  run_id: 'run-1',
  artifact_hash: 'hash',
  step: 'gate' as const,
  predecessor: 'digest',
  attempt: 1
}
const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'HIGH',
  confidence: 'HIGH',
  category: 'broken-contract',
  claim: 'The contract is broken.',
  evidence: [{ kind: 'file-line', ref: 'a.ts:1', quote: 'broken' }],
  remediation: 'Fix it.',
  stage: 'promote',
  disposition: 'standing',
  ...overrides
})
const base = {
  depth: 'standard' as const,
  reviewerResolved: true,
  artifactCaptured: true,
  prepassStatus: 'pass' as const,
  profile: 'code-diff' as const,
  chain
}

describe('evidence gate', () => {
  it('suppresses when any evidence item is demonstrably false', () => {
    const candidate = finding({
      evidence: [
        { kind: 'command', command: 'test', output: 'failed' },
        { kind: 'file-line', ref: 'gone.ts:1', quote: 'x' }
      ]
    })
    expect(applyEvidenceGate(candidate, { resolves: (item) => item.kind !== 'file-line' })).toEqual(
      {
        finding: null,
        reason: 'falsified'
      }
    )
  })

  it('never reruns absence and falsifies it when its recorded output is non-empty', () => {
    const candidate = finding({
      evidence: [{ kind: 'absence', command: 'grep x', ref: 'src', output: 'src/a.ts' }]
    })
    expect(applyEvidenceGate(candidate).finding).toBeNull()
  })

  it('caps un-reproduced CRITICAL/HIGH confidence, trusting prepass provenance only from that input', () => {
    const candidate = finding({ evidence: [{ kind: 'prepass', ref: 'test', output: 'failed' }] })
    expect(applyEvidenceGate(candidate).finding?.confidence).toBe('LOW')
    expect(applyEvidenceGate(candidate, { fromPrepass: true }).finding?.confidence).toBe('HIGH')
  })

  it('grades survivors, limitations, suppressions, dismissals, and stable ids', () => {
    const result = evaluateEvidenceGate({
      ...base,
      findings: [
        finding({ id: null, severity: 'MEDIUM' }),
        finding({ id: null, kind: 'limitation', category: 'environment-gap' }),
        finding({ id: 'F8', prior_id: 'F2', claim: 'Previously dismissed.' })
      ],
      dismissedPriorIds: new Set(['F2']),
      carriedSuppressed: [{ id: 'F1', reason: 'refuted' }],
      resolvesEvidence: () => true
    })
    expect(result.verdict).toBe('NEEDS_FIXES')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      id: 'F3',
      effective_severity: 'MEDIUM',
      blocking: true
    })
    expect(result.limitations).toHaveLength(1)
    expect(result.suppressed).toEqual([
      { id: 'F1', reason: 'refuted' },
      { id: 'F8', reason: 'dismissed' }
    ])
  })

  it('emits a verdict-less deep gate while a finding remains contested', () => {
    const result = evaluateEvidenceGate({
      ...base,
      depth: 'deep',
      findings: [finding({ disposition: 'contested' })],
      resolvesEvidence: () => true
    })
    expect(result.verdict).toBeUndefined()
    expect(result.contested_count).toBe(1)
  })
})
