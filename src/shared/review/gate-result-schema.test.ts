import { describe, expect, it } from 'vitest'
import { GateResultSchema } from './gate-result-schema'

const chain = { run_id: 'run-1', artifact_hash: 'deadbeef', step: 'gate', predecessor: 'digest', attempt: 1 }

const finding = {
  id: 'F1',
  severity: 'HIGH',
  confidence: 'HIGH',
  category: 'failing-check',
  claim: 'pnpm test fails.',
  evidence: [{ kind: 'prepass', ref: 'pnpm test', output: 'exit 1' }],
  remediation: 'Make the check pass.',
  stage: 'prepass',
  effective_severity: 'HIGH',
  blocking: true
}

describe('GateResultSchema', () => {
  it('round-trips a PASS verdict with nothing found', () => {
    const clean = {
      verdict: 'PASS',
      findings: [],
      limitations: [],
      questions: [],
      contested: [],
      suppressed: [],
      suppressed_count: 0,
      depth: 'standard',
      severity_histogram: {},
      blocking_count: 0,
      advisory_count: 0,
      contested_count: 0,
      unreviewed_paths: [],
      regrade_count: 0,
      chain
    }
    expect(GateResultSchema.parse(clean)).toEqual(clean)
  })

  it('round-trips a NEEDS_FIXES verdict with a blocking finding and a sparse histogram', () => {
    const needsFixes = {
      verdict: 'NEEDS_FIXES',
      findings: [finding],
      limitations: [],
      questions: [],
      contested: [],
      suppressed: [{ id: 'F2', reason: 'falsified' }],
      suppressed_count: 1,
      depth: 'standard',
      severity_histogram: { HIGH: 1 },
      blocking_count: 1,
      advisory_count: 0,
      contested_count: 0,
      unreviewed_paths: [],
      regrade_count: 0,
      chain
    }
    expect(GateResultSchema.safeParse(needsFixes).success).toBe(true)
  })

  it('round-trips a deep-depth contested gate with a ruling on the suppressed entry', () => {
    const contested = {
      verdict: 'NEEDS_FIXES',
      findings: [],
      limitations: [],
      questions: [],
      contested: [finding],
      suppressed: [{ id: 'F3', reason: 'refuted', ruling: 'evidence does not reproduce' }],
      suppressed_count: 1,
      depth: 'deep',
      severity_histogram: {},
      blocking_count: 0,
      advisory_count: 0,
      contested_count: 1,
      unreviewed_paths: [],
      regrade_count: 0,
      chain
    }
    expect(GateResultSchema.safeParse(contested).success).toBe(true)
  })

  it('rejects a verdict outside the pinned set', () => {
    expect(
      GateResultSchema.safeParse({
        verdict: 'MOSTLY_FINE',
        findings: [],
        limitations: [],
        questions: [],
        contested: [],
        suppressed: [],
        suppressed_count: 0,
        depth: 'standard',
        severity_histogram: {},
        blocking_count: 0,
        advisory_count: 0,
        contested_count: 0,
        unreviewed_paths: [],
        regrade_count: 0,
        chain
      }).success
    ).toBe(false)
  })
})
