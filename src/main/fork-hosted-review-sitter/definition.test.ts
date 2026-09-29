import { describe, expect, it, vi } from 'vitest'
import type { AuthorizedEnrollment, EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import {
  authorizeHostedReviewSitterDefinition,
  hostedReviewDefinitionFromEnrollment
} from './definition'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: vi.fn(async () => ({
    provider: 'github',
    number: 42,
    url: 'https://github.com/acme/repo/pull/42',
    state: 'open'
  }))
}))

const kindPayload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash',
  mergeCheckScope: 'all'
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
const legacyKindPayload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
} as const

function authorizationStore(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial Store double supplies only the methods authorization calls.
  return {
    getRepo: () => ({ id: 'repo-1', path: '/repo' }),
    getWorktreeMeta: () => undefined
  } as unknown as Store
}

function authorizationRuntime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime double supplies only the worktree lookup exercised by authorization.
  return {
    showManagedWorktree: async () => ({
      id: 'worktree-1',
      repoId: 'repo-1',
      git: {
        path: '/repo/worktree',
        isBare: false,
        prunable: false,
        branch: 'feature/review',
        head: 'head-1'
      }
    })
  } as unknown as OrcaRuntimeService
}

function authorizationInput(kindPayload: unknown): EnrollInput {
  return {
    kind: 'hosted-review',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: FOUR_CAPABILITIES,
    budget: { wallClockActiveMs: 3_600_000, turns: null },
    kindPayload
  }
}

async function authorize(kindPayload: unknown): Promise<AuthorizedEnrollment> {
  return authorizeHostedReviewSitterDefinition(
    authorizationRuntime(),
    authorizationStore(),
    authorizationInput(kindPayload)
  )
}

describe('hosted review merge-check scope', () => {
  it('defaults legacy definitions to all checks', () => {
    const definition = hostedReviewDefinitionFromEnrollment({
      ...baseEnrollment(FOUR_CAPABILITIES),
      kindPayload: legacyKindPayload
    })
    expect(definition.mergeCheckScope).toBe('all')
  })

  it('preserves explicit scope and defaults legacy candidates during authorization', async () => {
    const required = await authorize({ ...legacyKindPayload, mergeCheckScope: 'required' })
    const legacy = await authorize(legacyKindPayload)

    expect(required.kindPayload).toMatchObject({ mergeCheckScope: 'required' })
    expect(legacy.kindPayload).toMatchObject({ mergeCheckScope: 'all' })
  })
})

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
