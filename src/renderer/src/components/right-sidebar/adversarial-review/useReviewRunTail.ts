import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewRunTailSnapshot, ReviewRunTailSource } from './adversarial-review-model'

type ReviewRunTailState = {
  snapshot: ReviewRunTailSnapshot | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useReviewRunTail(
  source: ReviewRunTailSource | null,
  enabled: boolean
): ReviewRunTailState {
  const [snapshot, setSnapshot] = useState<ReviewRunTailSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const refresh = useCallback(() => {
    if (!source || !enabled) {
      return
    }
    const generation = generationRef.current
    setLoading(true)
    void source
      .read()
      .then((next) => {
        if (generation !== generationRef.current) {
          return
        }
        setSnapshot(next)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (generation !== generationRef.current) {
          return
        }
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (generation === generationRef.current) {
          setLoading(false)
        }
      })
  }, [enabled, source])

  useEffect(() => {
    generationRef.current += 1
    if (!source || !enabled) {
      return
    }
    const generation = generationRef.current
    let unsubscribe: (() => void) | null = null
    let disposed = false
    refresh()
    void Promise.resolve(source.subscribe(refresh))
      .then((nextUnsubscribe) => {
        if (disposed || generation !== generationRef.current) {
          nextUnsubscribe()
          return
        }
        unsubscribe = nextUnsubscribe
      })
      .catch((cause: unknown) => {
        if (!disposed && generation === generationRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      disposed = true
      generationRef.current += 1
      unsubscribe?.()
    }
  }, [enabled, refresh, source])

  return { snapshot, loading, error, refresh }
}
