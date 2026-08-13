import { describe, expect, it } from 'vitest'
import { RunManifestSchema } from './run-manifest-schema'

describe('RunManifestSchema', () => {
  const manifest = {
    reviewer: {
      agent: 'codex',
      family: 'openai',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      thinking: 'high',
      independence: 'full'
    },
    target: { kind: 'worktree', ref: 'WORKTREE', artifact_hash: 'deadbeef', size_metric: 42 },
    profile: 'code-diff',
    depth: 'standard',
    lens: null,
    prepass: {
      status: 'pass',
      checks: [{ name: 'code-check', command: 'pnpm test', exit_code: 0, status: 'pass' }]
    },
    suppressed_count: 0,
    severity_histogram: {},
    blocking_count: 0,
    advisory_count: 0,
    regrade_count: 0,
    limitation_count: 0,
    question_count: 0,
    unreviewed_paths: [],
    verdict: 'PASS',
    trust: {
      worker_bound: 'prompt',
      output_channel: 'driver-written',
      artifact_snapshot: 'diff+materialized-tree',
      workspace_trust: null
    },
    launch_receipts: [
      {
        stage: 'promote',
        attempt: 1,
        requested: { agent: 'codex', model: null, effort: null },
        effective: { agent: 'codex', model: null, effort: null }
      }
    ]
  }

  it('round-trips a clean PASS manifest', () => {
    expect(RunManifestSchema.parse(manifest)).toEqual(manifest)
  })

  it('round-trips a manifest with an unresolved reviewer and no launch receipt yet', () => {
    const notReviewable = {
      ...manifest,
      reviewer: {
        agent: null,
        family: null,
        provider: null,
        model: null,
        thinking: null,
        independence: 'reduced'
      },
      verdict: 'NOT_REVIEWABLE',
      launch_receipts: [
        {
          stage: 'promote',
          attempt: 1,
          requested: { agent: null, model: null, effort: null },
          effective: null
        }
      ]
    }
    expect(RunManifestSchema.safeParse(notReviewable).success).toBe(true)
  })

  it('rejects a trust.worker_bound outside the pinned literal', () => {
    expect(
      RunManifestSchema.safeParse({
        ...manifest,
        trust: { ...manifest.trust, worker_bound: 'sandboxed' }
      }).success
    ).toBe(false)
  })
})
