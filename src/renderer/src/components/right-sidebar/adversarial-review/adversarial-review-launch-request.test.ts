import { describe, expect, it, vi } from 'vitest'
import {
  consumeAdversarialReviewLaunchRequest,
  requestAdversarialReviewLaunch,
  subscribeAdversarialReviewLaunchRequests
} from './adversarial-review-launch-request'

describe('adversarial-review launch request', () => {
  it('survives the source-control panel unmount and is consumed once', () => {
    expect(consumeAdversarialReviewLaunchRequest()).toBeUndefined()
    requestAdversarialReviewLaunch()
    expect(consumeAdversarialReviewLaunchRequest()).toBeNull()
    expect(consumeAdversarialReviewLaunchRequest()).toBeUndefined()
  })

  it('notifies an already-mounted review panel', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAdversarialReviewLaunchRequests(listener)
    requestAdversarialReviewLaunch()
    expect(listener).toHaveBeenCalledOnce()
    consumeAdversarialReviewLaunchRequest()
    unsubscribe()
  })

  it('carries a hosted-review preset into the launch dialog', () => {
    const preset = { targetKind: 'hosted' as const, target: 'https://git.example/review/42' }
    requestAdversarialReviewLaunch(preset)
    expect(consumeAdversarialReviewLaunchRequest()).toEqual(preset)
  })
})
