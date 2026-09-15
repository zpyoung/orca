import { describe, expect, it, vi } from 'vitest'
import {
  ADVERSARIAL_REVIEW_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import { REVIEW_METHODS } from './review'

const EXPECTED_METHODS = [
  'review.runCreate',
  'review.resolve',
  'review.prepass',
  'review.selectModel',
  'review.stagePrompt',
  'review.claims',
  'review.merge',
  'review.gate',
  'review.manifest',
  'review.runAbort',
  'review.runList',
  'review.runShow',
  'review.runFail',
  'review.dismiss',
  'review.staleness',
  'review.plan'
]

describe('review RPC methods', () => {
  it('registers the v1 method table and capability', () => {
    expect(REVIEW_METHODS.map((method) => method.name)).toEqual(EXPECTED_METHODS)
    expect(ADVERSARIAL_REVIEW_RUNTIME_CAPABILITY).toBe('adversarial-review.v1')
    expect(RUNTIME_CAPABILITIES).toContain(ADVERSARIAL_REVIEW_RUNTIME_CAPABILITY)
  })

  it('routes lifecycle params to the runtime service', async () => {
    const reviewRunFail = vi.fn().mockResolvedValue({ failed: true })
    const method = REVIEW_METHODS.find((candidate) => candidate.name === 'review.runFail')
    const params = method?.params?.parse({
      worktree: 'path:/workspace',
      run: '0123456789abcdef',
      reason: 'worker failed'
    })
    expect(method).toBeDefined()
    expect(await method?.handler(params, { runtime: { reviewRunFail } as never })).toEqual({
      failed: true
    })
    expect(reviewRunFail).toHaveBeenCalledWith(
      'path:/workspace',
      '0123456789abcdef',
      'worker failed'
    )
  })

  it('rejects malformed run ids at the RPC boundary', () => {
    const method = REVIEW_METHODS.find((candidate) => candidate.name === 'review.runShow')
    expect(() => method?.params?.parse({ worktree: 'current', run: '../other' })).toThrow(
      'Invalid review run'
    )
  })
})
