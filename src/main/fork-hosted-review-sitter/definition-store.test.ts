import { describe, expect, it } from 'vitest'
import { enrollmentPayloadSchema, parseHostedReviewEnrollmentPayload } from './definition-store'

const payload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash'
} as const

describe('hosted review enrollment payload', () => {
  it('accepts the authoritative hosted review identity and policy', () => {
    expect(parseHostedReviewEnrollmentPayload(payload)).toEqual(payload)
    expect(enrollmentPayloadSchema.parse(payload)).toEqual(payload)
  })

  it('rejects incomplete, non-http and unknown-provider payloads', () => {
    expect(parseHostedReviewEnrollmentPayload({ ...payload, reviewNumber: 0 })).toBeNull()
    expect(
      parseHostedReviewEnrollmentPayload({ ...payload, reviewUrl: 'file:///tmp/review' })
    ).toBeNull()
    expect(parseHostedReviewEnrollmentPayload({ ...payload, provider: 'other' })).toBeNull()
    expect(parseHostedReviewEnrollmentPayload({ branchUpdateMode: 'rebase' })).toBeNull()
  })

  it('strips untrusted extra identity fields rather than persisting them', () => {
    expect(
      enrollmentPayloadSchema.parse({ ...payload, repoPath: '/renderer/path', token: 'secret' })
    ).toEqual(payload)
  })
})
