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

export function tagHostedReviewPreDispatchError(error: unknown): Error & { effect: 'not-landed' } {
  if (error instanceof Error && error.name === 'LeaseLostError') {
    throw error
  }
  const tagged = error instanceof Error ? error : new Error(String(error))
  return Object.assign(tagged, { effect: 'not-landed' as const })
}

export function expectedStateMismatch(detail: string): Error & {
  effect: 'not-landed'
  reason: 'expected-state-mismatch'
} {
  return Object.assign(new Error(detail), {
    effect: 'not-landed' as const,
    reason: 'expected-state-mismatch' as const
  })
}
