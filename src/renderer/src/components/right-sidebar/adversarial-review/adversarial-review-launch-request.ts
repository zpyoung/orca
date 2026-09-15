import type { ReviewLaunchTargetKind } from './adversarial-review-model'

export type AdversarialReviewLaunchPreset = {
  targetKind: ReviewLaunchTargetKind
  target: string
}

let pendingLaunchRequest: AdversarialReviewLaunchPreset | null | undefined
let requestVersion = 0
const listeners = new Set<() => void>()

export function requestAdversarialReviewLaunch(
  preset: AdversarialReviewLaunchPreset | null = null
): void {
  pendingLaunchRequest = preset
  requestVersion += 1
  for (const listener of listeners) {
    listener()
  }
}

export function getAdversarialReviewLaunchRequestVersion(): number {
  return requestVersion
}

export function subscribeAdversarialReviewLaunchRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function consumeAdversarialReviewLaunchRequest():
  | AdversarialReviewLaunchPreset
  | null
  | undefined {
  const request = pendingLaunchRequest
  pendingLaunchRequest = undefined
  return request
}
