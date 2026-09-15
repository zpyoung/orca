import { describe, expect, it } from 'vitest'
import type { Finding } from './finding-schema'
import { computeVerdict, effectiveSeverity, isBlocking, verdictExitCode } from './verdict'

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'HIGH',
  confidence: 'HIGH',
  category: 'broken-contract',
  claim: 'The contract is broken.',
  evidence: [{ kind: 'command', command: 'test', output: 'failed' }],
  remediation: 'Fix it.',
  stage: 'promote',
  ...overrides
})

const context = {
  reviewerResolved: true,
  artifactCaptured: true,
  prepassStatus: 'pass' as const,
  profile: 'code-diff' as const
}

describe('verdict fence', () => {
  it('uses adjudicated severity and the pinned blocking exception', () => {
    expect(effectiveSeverity(finding({ adjudicated_severity: 'MEDIUM', stage: 'refute' }))).toBe(
      'MEDIUM'
    )
    expect(isBlocking(finding({ confidence: 'LOW' }))).toBe(false)
    expect(isBlocking(finding({ severity: 'CRITICAL', confidence: 'LOW' }))).toBe(true)
    expect(isBlocking(finding({ confidence: 'LOW', stage: 'refute' }))).toBe(true)
  })

  it('maps blockers and preserves the pinned exit map', () => {
    expect(computeVerdict({ ...context, findings: [finding({ severity: 'CRITICAL' })] })).toBe(
      'CRITICAL_ISSUES'
    )
    expect(computeVerdict({ ...context, findings: [finding()] })).toBe('NEEDS_FIXES')
    expect(computeVerdict({ ...context, findings: [finding({ confidence: 'LOW' })] })).toBe('PASS')
    expect(verdictExitCode('NOT_REVIEWABLE')).toBe(4)
  })

  it('evaluates NOT_REVIEWABLE first and withholds a contested verdict', () => {
    expect(computeVerdict({ ...context, reviewerResolved: false, findings: [] })).toBe(
      'NOT_REVIEWABLE'
    )
    expect(computeVerdict({ ...context, prepassStatus: 'could-not-run', findings: [] })).toBe(
      'NOT_REVIEWABLE'
    )
    expect(
      computeVerdict({ ...context, profile: 'plan', prepassStatus: 'could-not-run', findings: [] })
    ).toBe('PASS')
    expect(
      computeVerdict({ ...context, findings: [], contested: [finding({ severity: 'LOW' })] })
    ).toBeNull()
  })
})
