export type HostedReviewSitterMutationTracker = {
  readonly dispatched: boolean
  markDispatched(): void
}

export function createHostedReviewSitterMutationTracker(): HostedReviewSitterMutationTracker {
  let dispatched = false
  return {
    get dispatched() {
      return dispatched
    },
    markDispatched() {
      dispatched = true
    }
  }
}

export function tagHostedReviewPreDispatchError(error: unknown): Error & { effect: 'none' } {
  const tagged = error instanceof Error ? error : new Error(String(error))
  return Object.assign(tagged, { effect: 'none' as const })
}
