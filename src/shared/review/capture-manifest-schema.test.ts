import { describe, expect, it } from 'vitest'
import { CaptureManifestSchema } from './capture-manifest-schema'

describe('CaptureManifestSchema', () => {
  const worktree = {
    target_kind: 'worktree',
    scope: 'WORKTREE',
    baseline_oid: null,
    head_oid: null,
    provider_ref: null,
    diff_file: null,
    untracked_paths: ['new-file.ts'],
    file_modes: 'recorded-in-diff',
    symlinks: 'recorded-not-followed',
    exclusions: ['.orca-review/**'],
    generated_outputs: [],
    hash: 'deadbeef',
    hash_inputs: 'diff-text',
    hashed_at: '2026-08-13T00:00:00Z'
  }

  it('round-trips a worktree capture with no OID identity', () => {
    expect(CaptureManifestSchema.parse(worktree)).toEqual(worktree)
  })

  it('round-trips a commit capture with resolved OIDs', () => {
    const commit = {
      ...worktree,
      target_kind: 'commit',
      baseline_oid: 'a'.repeat(40),
      head_oid: 'b'.repeat(40),
      hash_inputs: 'raw-bytes'
    }
    expect(CaptureManifestSchema.safeParse(commit).success).toBe(true)
  })

  it('round-trips a hosted capture with a provider ref', () => {
    expect(
      CaptureManifestSchema.safeParse({ ...worktree, target_kind: 'hosted', provider_ref: 'PR#42' })
        .success
    ).toBe(true)
  })

  it('rejects a file_modes value other than the pinned literal', () => {
    expect(CaptureManifestSchema.safeParse({ ...worktree, file_modes: 'ignored' }).success).toBe(
      false
    )
  })

  it('rejects an unknown hash_inputs value', () => {
    expect(CaptureManifestSchema.safeParse({ ...worktree, hash_inputs: 'checksum' }).success).toBe(
      false
    )
  })
})
