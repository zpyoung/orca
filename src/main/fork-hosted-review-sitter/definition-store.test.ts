import { describe, expect, it } from 'vitest'
import { HostedReviewEnrollmentCandidateSchema } from '../../shared/fork-hosted-review-sitter/enrollment-candidate'
import { enrollmentPayloadSchema, parseHostedReviewEnrollmentPayload } from './definition-store'

const payload = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://github.com/acme/repo/pull/42',
  branchUpdateMode: 'merge-base-update',
  mergeMethod: 'squash',
  mergeCheckScope: 'all'
} as const

const legacyPayload = {
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

  it('allows identity-free candidates without relaxing persisted enrollment requirements', () => {
    const candidate = { branchUpdateMode: 'rebase', mergeMethod: null }

    expect(HostedReviewEnrollmentCandidateSchema.safeParse(candidate)).toEqual({
      success: true,
      data: { ...candidate, mergeCheckScope: 'all' }
    })
    expect(enrollmentPayloadSchema.safeParse(candidate).success).toBe(false)
    expect(parseHostedReviewEnrollmentPayload(candidate)).toBeNull()
  })

  it('defaults legacy stored payloads to all checks while preserving explicit required scope', () => {
    expect(parseHostedReviewEnrollmentPayload(legacyPayload)).toEqual({
      ...legacyPayload,
      mergeCheckScope: 'all'
    })
    expect(parseHostedReviewEnrollmentPayload(legacyPayload)).not.toHaveProperty('repeatFixLimit')
    expect(
      parseHostedReviewEnrollmentPayload({ ...legacyPayload, mergeCheckScope: 'required' })
    ).toEqual({ ...legacyPayload, mergeCheckScope: 'required' })
  })

  it('preserves configured repeat limits and rejects values outside the supported range', () => {
    const candidate = { branchUpdateMode: 'rebase', mergeMethod: null }
    const withLimit = { ...payload, repeatFixLimit: 5 }

    expect(parseHostedReviewEnrollmentPayload(withLimit)).toEqual(withLimit)
    expect(enrollmentPayloadSchema.parse(withLimit)).toEqual(withLimit)
    expect(
      HostedReviewEnrollmentCandidateSchema.parse({ ...candidate, repeatFixLimit: 5 })
    ).toEqual({ ...candidate, mergeCheckScope: 'all', repeatFixLimit: 5 })
    for (const repeatFixLimit of [0, 11]) {
      expect(enrollmentPayloadSchema.safeParse({ ...payload, repeatFixLimit }).success).toBe(false)
      expect(
        HostedReviewEnrollmentCandidateSchema.safeParse({ ...candidate, repeatFixLimit }).success
      ).toBe(false)
    }
  })

  it('rejects incomplete, non-http and unknown-provider payloads', () => {
    expect(parseHostedReviewEnrollmentPayload({ ...payload, reviewNumber: 0 })).toBeNull()
    expect(
      parseHostedReviewEnrollmentPayload({ ...payload, reviewUrl: 'file:///tmp/review' })
    ).toBeNull()
    expect(parseHostedReviewEnrollmentPayload({ ...payload, provider: 'other' })).toBeNull()
    expect(
      parseHostedReviewEnrollmentPayload({ ...payload, mergeCheckScope: 'optional' })
    ).toBeNull()
    expect(parseHostedReviewEnrollmentPayload({ branchUpdateMode: 'rebase' })).toBeNull()
  })

  it('strips untrusted extra identity fields rather than persisting them', () => {
    expect(
      enrollmentPayloadSchema.parse({ ...payload, repoPath: '/renderer/path', token: 'secret' })
    ).toEqual(payload)
  })
})
