import { describe, expect, it } from 'vitest'
import { PrepassResultSchema } from './prepass-result-schema'

const chain = { run_id: 'run-1', artifact_hash: 'deadbeef', step: 'prepass', predecessor: 'digest', attempt: 1 }

describe('PrepassResultSchema', () => {
  it('round-trips a passing pre-pass with no findings', () => {
    const passing = {
      status: 'pass',
      checks: [{ name: 'code-check', command: 'pnpm test', exit_code: 0, status: 'pass', output: '' }],
      findings: [],
      observed_artifact_hash: 'deadbeef',
      chain
    }
    expect(PrepassResultSchema.parse(passing)).toEqual(passing)
  })

  it('round-trips a failing check surfaced as a HIGH/HIGH finding', () => {
    const failing = {
      status: 'fail',
      checks: [
        { name: 'code-check', command: 'pnpm test', exit_code: 1, status: 'fail', output: '1 failed' }
      ],
      findings: [
        {
          severity: 'HIGH',
          confidence: 'HIGH',
          category: 'failing-check',
          claim: 'A repository check fails on this target: pnpm test exited 1.',
          evidence: [{ kind: 'prepass', ref: 'pnpm test', output: '1 failed' }],
          remediation: 'Make the check pass, or explain why its failure is expected here.',
          stage: 'prepass'
        }
      ],
      observed_artifact_hash: 'deadbeef',
      chain
    }
    expect(PrepassResultSchema.safeParse(failing).success).toBe(true)
  })

  it('round-trips a could-not-run pre-pass with a null observed hash', () => {
    const couldNotRun = {
      status: 'could-not-run',
      checks: [],
      findings: [],
      observed_artifact_hash: null,
      chain
    }
    expect(PrepassResultSchema.safeParse(couldNotRun).success).toBe(true)
  })

  it('rejects an unknown status', () => {
    expect(
      PrepassResultSchema.safeParse({
        status: 'skipped',
        checks: [],
        findings: [],
        observed_artifact_hash: null,
        chain
      }).success
    ).toBe(false)
  })
})
