import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REVIEW_CHECK_OUTPUT_CHARS,
  REVIEW_CHECK_DISCOVERY,
  REVIEW_CHECK_TIMEOUT_MS,
  resolveReviewCheckPlan,
  runReviewChecks,
  shapeReviewCheckResult,
  shapeReviewPrepassCoreResult
} from './review-check-runner'

describe('review check discovery', () => {
  it('pins the upstream fallback table and execution bounds', () => {
    expect(REVIEW_CHECK_TIMEOUT_MS).toBe(900_000)
    expect(MAX_REVIEW_CHECK_OUTPUT_CHARS).toBe(4_000)
    expect(REVIEW_CHECK_DISCOVERY).toEqual([
      { marker: 'pyproject.toml', command: 'python3 -m pytest -q' },
      { marker: 'package.json', command: 'pnpm test' },
      { marker: 'Cargo.toml', command: 'cargo test --quiet' }
    ])
  })

  it('uses ordered project checks before detected fallback checks', () => {
    expect(
      resolveReviewCheckPlan({
        config: {
          checks: [' pnpm lint ', 'pnpm test'],
          generatedOutputs: [' coverage/** ', '.pytest_cache/**']
        },
        detectedMarkers: ['pyproject.toml', 'package.json']
      })
    ).toEqual({
      commands: ['pnpm lint', 'pnpm test'],
      generatedOutputs: ['coverage/**', '.pytest_cache/**'],
      source: 'project-config'
    })
  })

  it('discovers every present marker in pinned table order', () => {
    expect(
      resolveReviewCheckPlan({
        config: { checks: [] },
        detectedMarkers: ['Cargo.toml', 'pyproject.toml']
      })
    ).toEqual({
      commands: ['python3 -m pytest -q', 'cargo test --quiet'],
      generatedOutputs: [],
      source: 'fallback'
    })
  })

  it('returns no commands when neither config nor a marker supplies one', () => {
    expect(resolveReviewCheckPlan({ detectedMarkers: [] }).commands).toEqual([])
  })
})

describe('review check result shaping', () => {
  it('combines stdout then stderr and retains only the last 4,000 characters', () => {
    const result = shapeReviewCheckResult('pnpm test', {
      exitCode: 2,
      stdout: `prefix-${'a'.repeat(3_000)}`,
      stderr: 'b'.repeat(2_000)
    })

    expect(result).toMatchObject({
      name: 'code-check',
      command: 'pnpm test',
      exit_code: 2,
      status: 'fail'
    })
    expect(result.output).toHaveLength(4_000)
    expect(result.output).toBe(`${'a'.repeat(2_000)}${'b'.repeat(2_000)}`)
  })

  it('passes the fixed bounds to a host-aware executor and preserves order', async () => {
    const execute = vi.fn(async ({ command }: { command: string }) => ({
      exitCode: command === 'second' ? 1 : 0,
      stdout: command
    }))

    const checks = await runReviewChecks(['first', 'second'], execute)

    expect(execute.mock.calls).toEqual([
      [
        {
          command: 'first',
          timeoutMs: 900_000,
          maxOutputChars: 4_000
        }
      ],
      [
        {
          command: 'second',
          timeoutMs: 900_000,
          maxOutputChars: 4_000
        }
      ]
    ])
    expect(checks.map(({ command, status }) => ({ command, status }))).toEqual([
      { command: 'first', status: 'pass' },
      { command: 'second', status: 'fail' }
    ])
  })

  it('turns every failed check into the pinned HIGH/HIGH finding shape', () => {
    const check = shapeReviewCheckResult('pnpm test', {
      exitCode: 1,
      stderr: `leading-${'x'.repeat(2_100)}`
    })
    const result = shapeReviewPrepassCoreResult({
      checks: [check],
      observedArtifactHash: 'artifact-hash'
    })

    expect(result.status).toBe('fail')
    expect(result.observed_artifact_hash).toBe('artifact-hash')
    expect(result.findings).toEqual([
      {
        id: '',
        severity: 'HIGH',
        confidence: 'HIGH',
        category: 'failing-check',
        claim: 'A repository check fails on this target: pnpm test exited 1.',
        evidence: [
          {
            kind: 'prepass',
            ref: 'pnpm test',
            output: 'x'.repeat(2_000)
          }
        ],
        remediation: 'Make the check pass, or explain why its failure is expected here.',
        patch: null,
        stage: 'prepass'
      }
    ])
  })

  it('reports could-not-run when no applicable check exists', () => {
    expect(
      shapeReviewPrepassCoreResult({
        checks: [],
        observedArtifactHash: null
      })
    ).toEqual({
      status: 'could-not-run',
      checks: [],
      findings: [],
      observed_artifact_hash: null
    })
  })
})
