import { useCallback, useMemo, useRef, useState } from 'react'
import {
  mergeNativeChatTranscriptCompanion,
  type NativeChatTranscriptCompanion
} from '../../../../shared/native-chat-transcript-companion'

type TranscriptCompanionState = {
  companion?: NativeChatTranscriptCompanion
}

type TranscriptCompanionControl = {
  reset: () => void
  replace: (companion: NativeChatTranscriptCompanion | undefined) => void
  append: (companion: NativeChatTranscriptCompanion | undefined) => void
  revision: () => number
  replaceFromPagination: (
    companion: NativeChatTranscriptCompanion | undefined,
    revision: number
  ) => void
}

/**
 * Newest-wins store for the values a transcript read carries beside the messages.
 *
 * The two fields differ on what a *replacement* means, which is the whole reason
 * they share one store rather than each getting their own call sites: a lifecycle
 * describes the window that was just read, so a replacement without one clears it;
 * a recorded model or effort stays true no matter where the read window moved, so
 * a replacement without one keeps the value already observed.
 */
export function useNativeChatTranscriptCompanion(): readonly [
  NativeChatTranscriptCompanion | undefined,
  TranscriptCompanionControl
] {
  const [state, setState] = useState<TranscriptCompanionState>({})
  // Why: pagination may resolve after a live completion; its older boundary
  // can update history only when no live write won the race.
  const revisionRef = useRef(0)

  const replace = useCallback((companion: NativeChatTranscriptCompanion | undefined): void => {
    revisionRef.current += 1
    setState((current) => ({
      companion: mergeNativeChatTranscriptCompanion(
        current.companion?.sessionOptions
          ? { sessionOptions: current.companion.sessionOptions }
          : undefined,
        companion
      )
    }))
  }, [])
  const reset = useCallback((): void => {
    revisionRef.current += 1
    setState({})
  }, [])
  const append = useCallback((companion: NativeChatTranscriptCompanion | undefined): void => {
    if (!companion) {
      return
    }
    revisionRef.current += 1
    setState((current) => ({
      companion: mergeNativeChatTranscriptCompanion(current.companion, companion)
    }))
  }, [])
  const revision = useCallback((): number => revisionRef.current, [])
  const replaceFromPagination = useCallback(
    (companion: NativeChatTranscriptCompanion | undefined, expectedRevision: number): void => {
      if (!companion || revisionRef.current !== expectedRevision) {
        return
      }
      revisionRef.current += 1
      setState((current) => ({
        companion: mergeNativeChatTranscriptCompanion(current.companion, companion)
      }))
    },
    []
  )

  const control = useMemo<TranscriptCompanionControl>(
    () => ({ reset, replace, append, revision, replaceFromPagination }),
    [append, replace, replaceFromPagination, reset, revision]
  )
  return [state.companion, control]
}
