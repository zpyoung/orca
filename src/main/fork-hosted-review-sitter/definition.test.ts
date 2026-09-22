import { describe, expect, it } from 'vitest'
import type { AuthorizedEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { hostedReviewDefinitionFromEnrollment } from './definition'

const kindPayload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
} as const

function baseEnrollment(
  capabilities: Record<string, 'off' | 'gated' | 'on'>
): Pick<
  AuthorizedEnrollment,
  'repoId' | 'worktreeId' | 'workspacePath' | 'capabilities' | 'kindPayload'
> {
  return {
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/repo',
    capabilities,
    kindPayload
  }
}

const FOUR_CAPABILITIES = {
  updateBranch: 'on',
  resolveConflicts: 'off',
  fixChecks: 'gated',
  merge: 'off'
} as const

describe('hosted review capability re-parse tolerates an owner-configured enrollment', () => {
  it('parses a persisted enrollment with no owner-intervention key exactly as today', () => {
    const definition = hostedReviewDefinitionFromEnrollment(baseEnrollment(FOUR_CAPABILITIES))
    expect(definition.capabilities).toEqual(FOUR_CAPABILITIES)
  })

  it('tolerates an owner-configured enrollment without leaking owner-intervention into the definition', () => {
    const definition = hostedReviewDefinitionFromEnrollment(
      baseEnrollment({ ...FOUR_CAPABILITIES, 'owner-intervention': 'on' })
    )
    expect(definition.capabilities).toEqual(FOUR_CAPABILITIES)
    expect(Object.keys(definition.capabilities)).not.toContain('owner-intervention')
  })

  it('still rejects any other unrecognized capability key', () => {
    expect(() =>
      hostedReviewDefinitionFromEnrollment(
        baseEnrollment({ ...FOUR_CAPABILITIES, 'some-other-key': 'on' })
      )
    ).toThrow()
  })
})
