import { describe, expect, it } from 'vitest'
import {
  ChainSchema,
  MergeChainSchema,
  ModelSelectionSchema,
  ResolveResultSchema,
  RunRecordSchema
} from './stage-schemas'

const chain = { run_id: 'abc123', artifact_hash: 'deadbeef', step: 'resolve', predecessor: null, attempt: 1 }

describe('ChainSchema', () => {
  it('round-trips a minted-run chain', () => {
    expect(ChainSchema.parse(chain)).toEqual(chain)
  })

  it('accepts a chained step with a predecessor digest', () => {
    const next = { ...chain, step: 'prepass', predecessor: 'digest-of-resolve', attempt: 1 }
    expect(ChainSchema.safeParse(next).success).toBe(true)
  })

  it.each([0, -1])('rejects an attempt below 1 (%i)', (attempt) => {
    expect(ChainSchema.safeParse({ ...chain, attempt }).success).toBe(false)
  })

  it('rejects an unknown step', () => {
    expect(ChainSchema.safeParse({ ...chain, step: 'bogus' }).success).toBe(false)
  })
})

describe('MergeChainSchema', () => {
  const merge = { ...chain, step: 'merge', predecessor: 'digest-of-claims', stage: 'refute' }

  it('round-trips a refute-stage merge chain', () => {
    expect(MergeChainSchema.parse(merge)).toEqual(merge)
  })

  it('round-trips a tiebreak-stage merge chain', () => {
    expect(MergeChainSchema.safeParse({ ...merge, stage: 'tiebreak' }).success).toBe(true)
  })

  it('rejects a chain whose step is not merge', () => {
    expect(MergeChainSchema.safeParse({ ...merge, step: 'gate' }).success).toBe(false)
  })

  it('rejects an unknown stage', () => {
    expect(MergeChainSchema.safeParse({ ...merge, stage: 'promote' }).success).toBe(false)
  })
})

describe('ResolveResultSchema', () => {
  const resolved = {
    profile: 'code-diff',
    target_kind: 'worktree',
    target_ref: 'WORKTREE',
    artifact_hash: 'deadbeef',
    diff_file: null,
    untracked_paths: ['new-file.ts'],
    size_metric: 42,
    depth_suggestion: 'quick',
    contract_surface: false,
    chain
  }

  it('round-trips a worktree resolve result', () => {
    expect(ResolveResultSchema.parse(resolved)).toEqual(resolved)
  })

  it('round-trips a hosted target, one of the port-added target kinds', () => {
    expect(
      ResolveResultSchema.safeParse({ ...resolved, target_kind: 'hosted', target_ref: 'PR#42' })
        .success
    ).toBe(true)
  })

  it('rejects an unknown profile', () => {
    expect(ResolveResultSchema.safeParse({ ...resolved, profile: 'freeform' }).success).toBe(false)
  })

  it('tolerates an unknown field for forward compatibility', () => {
    expect(ResolveResultSchema.safeParse({ ...resolved, futureField: 1 }).success).toBe(true)
  })
})

describe('RunRecordSchema', () => {
  const running = {
    run_id: 'run-1',
    workspace_id: 'ws-1',
    state: 'running',
    verdict: null,
    campaign_hash: null,
    orchestration_run_id: 'orch-1',
    driver_terminal_handle: 'term-1',
    depth: 'standard',
    profile: 'code-diff',
    created_at: '2026-08-13T00:00:00Z',
    updated_at: '2026-08-13T00:00:00Z',
    protocol_version: 'quirk-2026.7.31+orca.1'
  }

  it('round-trips a running run with campaign fields still null', () => {
    expect(RunRecordSchema.parse(running)).toEqual(running)
  })

  it('round-trips a completed run with campaign fields populated', () => {
    const completed = {
      ...running,
      state: 'completed',
      verdict: 'PASS',
      campaign_hash: 'campaign-hash'
    }
    expect(RunRecordSchema.safeParse(completed).success).toBe(true)
  })

  it('rejects an unknown state', () => {
    expect(RunRecordSchema.safeParse({ ...running, state: 'paused' }).success).toBe(false)
  })

  it('rejects a verdict outside the pinned set', () => {
    expect(RunRecordSchema.safeParse({ ...running, verdict: 'MAYBE' }).success).toBe(false)
  })
})

describe('ModelSelectionSchema', () => {
  const resolved = {
    resolved: true,
    agent: 'codex',
    family: 'openai',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    thinking: 'high',
    independence: 'full',
    ladder: [{ agent: 'codex', checked: true, resolved: true }],
    chain: { ...chain, step: 'select-model' }
  }

  it('round-trips a resolved reviewer selection', () => {
    expect(ModelSelectionSchema.parse(resolved)).toEqual(resolved)
  })

  it('round-trips an unresolved selection where every field goes null', () => {
    const unresolved = {
      resolved: false,
      agent: null,
      family: null,
      provider: null,
      model: null,
      thinking: null,
      independence: 'reduced',
      ladder: [{ agent: 'codex', checked: true, resolved: false }],
      chain: { ...chain, step: 'select-model' }
    }
    expect(ModelSelectionSchema.safeParse(unresolved).success).toBe(true)
  })

  it('rejects an unknown independence value', () => {
    expect(ModelSelectionSchema.safeParse({ ...resolved, independence: 'partial' }).success).toBe(
      false
    )
  })
})
