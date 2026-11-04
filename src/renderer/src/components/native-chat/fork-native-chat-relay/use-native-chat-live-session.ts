// FORK-COPY-OF: src/renderer/src/components/native-chat/use-native-chat-live-session.ts
// FORK-COPY-SHA: 965978bc78bf03a6a43187c1ed28fcffe0e01bb5
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage,
  type NativeChatSession,
  type NativeChatTurnLifecycle,
  type NativeChatSessionOptionObservation
} from '../../../../../shared/native-chat/native-chat-types'
import type { AgentType } from '../../../../../shared/agent-status-types'
import { nativeChatCompanionFromFrame } from '../../../../../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../../shared/native-chat/native-chat-merge'
import { startNativeChatSeedRead } from './native-chat-read-retry'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { useNativeChatAssembledTranscript } from './use-native-chat-assembled-transcript'
import {
  hasMoreBeforeNativeChatPage,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatPageRequest,
  resolveNativeChatHasMore,
  type NativeChatOlderPageResult
} from './native-chat-pagination'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptCompanion } from '../fork-native-chat-session-options/use-native-chat-transcript-companion'
import { useNativeChatHookStatus } from '../use-native-chat-hook-status'
import { takeNativeChatOpenWake } from '../native-chat-open-wake'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` hook-entry key. */
  paneKey: string
  agent: AgentType
  /** Null until reported; use live hook state before there is a session to read. */
  sessionId: string | null
  /** Prefer the hook’s authoritative path over reconstruction from sessionId. */
  transcriptPath?: string | null
  /** Non-null routes reads/subscriptions to the owning remote host; null uses local IPC. */
  runtimeEnvironmentId?: string | null
  /** False suspends transcript IO while retaining the last committed session. */
  enabled?: boolean
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  /** Latest provider turn boundary, used to settle orphaned running tool rows. */
  transcriptLifecycle?: NativeChatTurnLifecycle
  /** The pane's hook says the agent stopped mid-turn for the reader, and the transcript
   *  has not since ended that turn. */
  hookAwaitingInput?: boolean
  /** Reconciled host work before read errors or retained-history presentation override status. */
  hookWorking?: boolean
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Changes whenever older-history paging is reset (source swap, snapshot, replacement);
   *  a failed page belongs to one generation. */
  olderHistoryGeneration: number
  /** Page in older history. Resolves once the page has landed (or not); a call while
   *  one is in flight joins it. */
  loadEarlier: () => Promise<NativeChatOlderPageResult>
  /** Raw initial-read phase. `status` is not a substitute: a live 'working' hook
   *  outranks (and so hides) 'loading', which would let a consumer deciding from
   *  an empty list treat an in-flight transcript as real history. */
  readPhase: ReadState['phase']
  /** The transcript is the host's present, not what a stopped or disconnected read left
   *  behind. Absent on a chat read from a terminal, which cannot say what the reader missed. */
  readCurrent?: boolean
  /** Model and effort the agent recorded for itself, newest turn first. Undefined
   *  until a turn lands, or on a host that predates the field. */
  sessionOptions?: NativeChatSessionOptionObservation
}

// Paging is the user's own click, so it may start a stopped WSL distro.
const USER_PAGING = { wakeWslDistro: true } as const

// Stable empty-base reference so a non-ready read doesn't churn the base axis.
const EMPTY_MESSAGES: readonly NativeChatMessage[] = []

let subscriptionCounter = 0

function nextSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}

export type ReadState =
  | { phase: 'loading' }
  /** The host reported no transcript behind this window yet: rendered, but not a
   *  settled read, so nothing may treat the empty list as real history. */
  | { phase: 'awaiting' }
  | { phase: 'ready'; messages: NativeChatMessage[] }
  | { phase: 'error'; error: string }

/** True while no transcript read has settled — 'loading' and 'awaiting' alike.
 *  Consumers that must not act on `messages` as real history use this, not a
 *  bare `!== 'ready'`, which would also swallow the error surface. */
export function isNativeChatTranscriptUnsettled(phase: ReadState['phase']): boolean {
  return phase === 'loading' || phase === 'awaiting'
}

/**
 * Renderer hook that streams a NativeChatSession for a pane: windowed
 * `readSession` + live `subscribe` tail, merged with live hook turn-state.
 *
 * Pagination: read is windowed to the most recent `limit` turns; `loadEarlier`
 * re-reads a larger window to prepend older history. Read results replace the
 * base list; live appends accumulate separately so a re-read never drops them.
 *
 * Transport: per-owner (getNativeChatSessionTransport) — a runtime-owned pane
 * (Model B) reads/tails the remote host; local panes keep the local IPC path.
 *
 * Teardown: subscription closes on unmount and on owner/agent/sessionId change so
 * a swap or owner-flip never leaks a watcher.
 */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId, enabled = true } = args
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [olderHistoryGeneration, setOlderHistoryGeneration] = useState(0)
  const [transcriptCompanion, transcriptCompanionControl] = useNativeChatTranscriptCompanion()
  // The active read window; raised by loadEarlier to page in older history.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)
  // Byte offset of the oldest loaded turn, from whichever read last replaced the
  // base list. Null when the reader reported none, which drops loadEarlier back
  // to growing the limit.
  const oldestOffsetRef = useRef<number | null>(null)

  // Separate live appends from snapshots so pagination cannot lose in-flight content.
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  // Cache the id index so each frame costs O(incoming), not O(existing).
  const appendMergerRef = useRef<ReturnType<typeof createNativeChatMerger>>(undefined!)
  appendMergerRef.current ??= createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY)

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

  const latestEnabled = useRef(enabled)
  // Read, not a dependency: the source key below already changes with the pane.
  const latestPaneKey = useRef(paneKey)
  // Fence late frames before passive cleanup closes the previous stream.
  useLayoutEffect(() => {
    latestEnabled.current = enabled
    latestPaneKey.current = paneKey
  }, [enabled, paneKey])
  const sourceKey = JSON.stringify([
    paneKey,
    runtimeEnvironmentId ?? null,
    agent,
    sessionId,
    transcriptPath ?? null
  ])
  const retainedSourceKeyRef = useRef(sourceKey)
  const latestSessionId = useRef<string | null>(sessionId)
  // Tracks the current transport so a load-earlier resolve from a prior host is discarded after an owner flip (session id can stay the same).
  const latestTransport = useRef(transport)
  const transcriptEpochRef = useRef(0)

  // Mirrored on commit rather than during render: a render React discards must not make a stale load-earlier resolve look current.
  useEffect(() => {
    latestSessionId.current = sessionId
    latestTransport.current = transport
  }, [sessionId, transport])

  useEffect(() => {
    // Agent/path/owner rebinds may retain sessionId; invalidate every prior pagination generation.
    transcriptEpochRef.current += 1
    setOlderHistoryGeneration(transcriptEpochRef.current)
    setLoadingEarlier(false)
    const sourceChanged = retainedSourceKeyRef.current !== sourceKey
    retainedSourceKeyRef.current = sourceKey
    if (!enabled) {
      if (sourceChanged) {
        limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
        oldestOffsetRef.current = null
        transcriptCompanionControl.reset()
        setRead({ phase: 'loading' })
        replaceList(appendMergerRef.current, [])
        setAppended([])
        setHasMore(false)
      }
      return
    }
    transcriptCompanionControl.reset()
    if (!sessionId) {
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return
    }

    let cancelled = false
    // Authoritative frames outrank the independent read seed.
    let frameArrived = false
    // Host-confirmed missing transcripts are expected until flushed, not errors.
    let transcriptPending = false
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    oldestOffsetRef.current = null
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)
    const wake = { wakeWslDistro: takeNativeChatOpenWake(latestPaneKey.current, sourceKey) }

    // Independent initial seed in case subscribe never delivers a snapshot; applied only until an authoritative frame lands so a live snapshot wins.
    const cancelSeedRead = startNativeChatSeedRead({
      read: () =>
        transport.readSession({
          agent,
          sessionId,
          limit: limitRef.current,
          ...(transcriptPath ? { transcriptPath } : {}),
          ...wake
        }),
      // A not-yet-flushed transcript: stay in 'loading' and retry with backoff instead of a permanent error (#8401).
      isPending: (result) =>
        !transcriptPending && Boolean(result && 'error' in result && result.notFound),
      isSuperseded: () => !latestEnabled.current || frameArrived,
      onResult: (result) => {
        if (result && 'error' in result) {
          // The live resolve-poll stream owns recovery once it confirms the file is
          // missing, so a notFound here is known-good news, not a failure to surface.
          if (!(transcriptPending && result.notFound)) {
            setRead({ phase: 'error', error: result.error })
          }
          return
        }
        const messages = result?.messages ?? []
        transcriptCompanionControl.replace(nativeChatCompanionFromFrame(result ?? {}))
        oldestOffsetRef.current = result?.beforeOffset ?? null
        setRead({ phase: 'ready', messages })
        setHasMore(resolveNativeChatHasMore(result?.hasMore, messages.length, limitRef.current))
      },
      onError: (error: unknown) => {
        setRead({ phase: 'error', error: error instanceof Error ? error.message : String(error) })
      }
    })

    const subscriptionId = nextSubscriptionId()
    const unsubscribe = transport.subscribe(
      {
        subscriptionId,
        agent,
        sessionId,
        transcriptPath: transcriptPath ?? undefined,
        limit: limitRef.current,
        wakeWslDistro: wake.wakeWslDistro
      },
      (frame) => {
        if (!cancelled && latestEnabled.current) {
          if (frame.type === 'snapshot' || frame.type === 'replacement') {
            // Why: snapshots and inode replacements are authoritative generations; older pagination must not repaint them.
            if ('error' in frame && frame.error) {
              frameArrived = true
              transcriptEpochRef.current += 1
              setOlderHistoryGeneration(transcriptEpochRef.current)
              setLoadingEarlier(false)
              setRead({ phase: 'error', error: frame.error })
              return
            }
            if (frame.type === 'snapshot' && frame.pending === true) {
              // No transcript exists yet (an agent that hasn't flushed, or was never
              // prompted). Move off 'loading' so the view stops spinning, but keep
              // an in-flight seed and appended tail eligible — this is not a read.
              transcriptPending = true
              setRead({ phase: 'awaiting' })
              return
            }
            frameArrived = true
            transcriptEpochRef.current += 1
            setOlderHistoryGeneration(transcriptEpochRef.current)
            setLoadingEarlier(false)
            transcriptCompanionControl.replace(nativeChatCompanionFromFrame(frame))
            replaceList(appendMergerRef.current, frame.messages)
            setAppended([])
            // An authoritative generation resets the paging cursor: it replaces
            // the base list, so any older offset captured from the seed read no
            // longer describes what is on screen.
            oldestOffsetRef.current = frame.beforeOffset ?? null
            limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
            setRead({ phase: 'ready', messages: appendMergerRef.current.list })
            setHasMore(frame.hasMore)
            return
          }
          transcriptCompanionControl.append(nativeChatCompanionFromFrame(frame))
          // Merge by id then bound to the window; the base read + assembler re-dedup mean trimming the append tail can't drop a covered turn (#6).
          setAppended(applyAppend(appendMergerRef.current, frame.messages, limitRef.current))
        }
      }
    )

    return () => {
      cancelled = true
      cancelSeedRead()
      unsubscribe()
    }
    // `transport` identity changes on an owner flip, re-running this effect to re-subscribe against the new host.
  }, [agent, enabled, sessionId, sourceKey, transcriptPath, transport, transcriptCompanionControl])

  // Concurrent callers share the current epoch’s page.
  const olderPageRef = useRef<{
    epoch: number
    promise: Promise<NativeChatOlderPageResult>
  } | null>(null)
  const loadEarlier = useCallback((): Promise<NativeChatOlderPageResult> => {
    const inFlight = olderPageRef.current
    if (inFlight?.epoch === transcriptEpochRef.current) {
      return inFlight.promise
    }
    if (!hasMore) {
      return Promise.resolve('exhausted')
    }
    if (!latestEnabled.current || !sessionId || read.phase !== 'ready') {
      return Promise.resolve('unchanged')
    }
    const request = nextNativeChatPageRequest(limitRef.current, oldestOffsetRef.current)
    const requestEpoch = transcriptEpochRef.current
    const companionRevision = transcriptCompanionControl.revision()
    const loadedCount = read.messages.length
    setLoadingEarlier(true)
    const promise = transport
      .readSession({
        agent,
        sessionId,
        limit: request.limit,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(request.mode === 'before' ? { beforeOffset: request.beforeOffset } : {}),
        ...USER_PAGING
      })
      .then((result): NativeChatOlderPageResult => {
        if (
          latestSessionId.current !== sessionId ||
          latestTransport.current !== transport ||
          !latestEnabled.current ||
          transcriptEpochRef.current !== requestEpoch
        ) {
          return 'superseded'
        }
        if (!result || 'error' in result) {
          return 'failed'
        }
        transcriptCompanionControl.replaceFromPagination(
          nativeChatCompanionFromFrame(result),
          companionRevision
        )
        if (request.mode === 'grow') {
          limitRef.current = request.limit
          // Read results are an ordered tail: replace the base list so the older page prepends in order; live appends stay separate.
          setRead({ phase: 'ready', messages: result.messages })
          oldestOffsetRef.current = result.beforeOffset ?? null
          const more = resolveNativeChatHasMore(
            result.hasMore,
            result.messages.length,
            request.limit
          )
          setHasMore(more)
          return result.messages.length > loadedCount ? 'applied' : more ? 'unchanged' : 'exhausted'
        }
        const hasMoreOlder = hasMoreBeforeNativeChatPage(
          result.hasMore,
          result.messages.length,
          request.beforeOffset,
          result.beforeOffset
        )
        // Pages abut at an exact byte offset, so the older page prepends whole.
        setRead((prev) =>
          prev.phase === 'ready'
            ? { phase: 'ready', messages: [...result.messages, ...prev.messages] }
            : prev
        )
        oldestOffsetRef.current = hasMoreOlder ? (result.beforeOffset ?? null) : null
        setHasMore(hasMoreOlder)
        return result.messages.length > 0 ? 'applied' : hasMoreOlder ? 'unchanged' : 'exhausted'
      })
      // Keep loaded history when pagination rejects.
      .catch((): NativeChatOlderPageResult => 'failed')
      .finally(() => {
        if (olderPageRef.current?.promise === promise) {
          olderPageRef.current = null
        }
        // Clear the loading flag on the current epoch even when the result is discarded, so a stale resolve can't wedge it true.
        if (transcriptEpochRef.current === requestEpoch) {
          setLoadingEarlier(false)
        }
      })
    olderPageRef.current = { epoch: requestEpoch, promise }
    return promise
  }, [agent, sessionId, transcriptPath, transport, hasMore, read, transcriptCompanionControl])

  // Keep status-only hook updates from rerunning the assembler.
  const baseMessages = read.phase === 'ready' ? read.messages : EMPTY_MESSAGES
  const surfacedMessages = useNativeChatAssembledTranscript(
    baseMessages,
    appended,
    sessionId,
    agent
  )

  return useMemo<NativeChatLiveSession>(() => {
    const session = mergeNativeChatLiveSession({
      sources: { transcript: surfacedMessages },
      sessionId,
      agent,
      hookState,
      stateStartedAt: hookStateStartedAt,
      transcriptLifecycle: transcriptCompanion?.lifecycle,
      hookHasWorkingSubagents,
      // Why: show live watcher-append content over a spinner (#8401), so the loading override applies only when nothing is appended.
      loading: read.phase === 'loading' && appended.length === 0,
      // The error is always reported; the view renders it inline once there is
      // content, so a permanently broken read is never silently indistinguishable
      // from a healthy pane.
      ...(read.phase === 'error' ? { error: read.error } : {})
    })
    return {
      ...session,
      hasMore,
      loadingEarlier,
      olderHistoryGeneration,
      loadEarlier,
      readPhase: read.phase,
      ...(transcriptCompanion?.sessionOptions
        ? { sessionOptions: transcriptCompanion.sessionOptions }
        : {})
    }
  }, [
    surfacedMessages,
    read,
    sessionId,
    agent,
    hookState,
    hookStateStartedAt,
    transcriptCompanion,
    hookHasWorkingSubagents,
    hasMore,
    loadingEarlier,
    olderHistoryGeneration,
    loadEarlier,
    appended
  ])
}
