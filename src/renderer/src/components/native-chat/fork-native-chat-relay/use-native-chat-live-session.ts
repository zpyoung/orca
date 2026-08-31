// FORK-COPY-OF: src/renderer/src/components/native-chat/use-native-chat-live-session.ts
// FORK-COPY-SHA: 6e4f817101daa18d82824b69243d9079baa9c416
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession,
  type NativeChatSessionOptionObservation
} from '../../../../../shared/native-chat-types'
import { nativeChatCompanionFromFrame } from '../../../../../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import {
  applyAppend,
  createNativeChatMerger,
  replaceList
} from '../../../../../shared/native-chat-merge'
import { startNativeChatSeedRead } from './native-chat-read-retry'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { useNativeChatAssembledTranscript } from './use-native-chat-assembled-transcript'
import {
  hasMoreBeforeNativeChatPage,
  NATIVE_CHAT_INITIAL_LIMIT,
  nextNativeChatPageRequest,
  resolveNativeChatHasMore
} from './native-chat-pagination'
import { getNativeChatSessionTransport } from './native-chat-session-transport'
import { useNativeChatTranscriptCompanion } from '../fork-native-chat-session-options/use-native-chat-transcript-companion'
import { useNativeChatHookStatus } from '../use-native-chat-hook-status'

export type UseNativeChatLiveSessionArgs = {
  /** Composite `${tabId}:${leafId}` key — selects the live hook entry. */
  paneKey: string
  agent: AgentType
  /** The agent's own session id, or null before it reports one — nothing to read/tail, so the view shows live hook state. */
  sessionId: string | null
  /** Authoritative transcript path from the hook, preferred over reconstructing it from sessionId. Null when not reported. */
  transcriptPath?: string | null
  /** Runtime owner (Model B): non-null routes read/subscribe to the remote host; null keeps the local IPC path. */
  runtimeEnvironmentId?: string | null
  /** Plain-`ssh:` owner (Model A): non-null makes main run transcript IO on that host's relay. */
  sshConnectionId?: string | null
}

/** A live session plus the older-history pagination controls the view needs. */
export type NativeChatLiveSession = NativeChatSession & {
  /** True when an older page may still exist (the last read filled the window). */
  hasMore: boolean
  /** Whether an older-history page is currently loading. */
  loadingEarlier: boolean
  /** Grow the read window to page in older history (scrolled-to-top trigger). */
  loadEarlier: () => void
  /** Raw initial-read phase. `status` is not a substitute: a live 'working' hook
   *  outranks (and so hides) 'loading', which would let a consumer deciding from
   *  an empty list treat an in-flight transcript as real history. */
  readPhase: ReadState['phase']
  /** Model and effort the agent recorded for itself, newest turn first. Undefined
   *  until a turn lands, or on a host that predates the field. */
  sessionOptions?: NativeChatSessionOptionObservation
}

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
 * (Model B) reads/tails the remote host; local/ssh panes keep the local IPC path.
 *
 * Teardown: subscription closes on unmount and on owner/agent/sessionId change so
 * a swap or owner-flip never leaks a watcher.
 */
export function useNativeChatLiveSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const { paneKey, agent, sessionId, transcriptPath, runtimeEnvironmentId, sshConnectionId } = args
  // Stable per owner id so a re-render without an owner flip keeps the same transport and doesn't re-subscribe.
  const transport = useMemo(
    () => getNativeChatSessionTransport(runtimeEnvironmentId ?? null),
    [runtimeEnvironmentId]
  )
  const [read, setRead] = useState<ReadState>({ phase: 'loading' })
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [transcriptCompanion, transcriptCompanionControl] = useNativeChatTranscriptCompanion()
  // The active read window; raised by loadEarlier to page in older history.
  const limitRef = useRef(NATIVE_CHAT_INITIAL_LIMIT)
  // Byte offset of the oldest loaded turn, from whichever read last replaced the
  // base list. Null when the reader reported none, which drops loadEarlier back
  // to growing the limit.
  const oldestOffsetRef = useRef<number | null>(null)

  // Appended messages accumulate separately from the snapshot so pagination doesn't lose in-flight appends; merged by id and capped to the read window (#6).
  const [appended, setAppended] = useState<NativeChatMessage[]>([])
  // Id-dedup merger backing `appended`; caches the id→index map so each live frame costs O(incoming), not O(existing) (#18).
  const appendMergerRef = useRef(createNativeChatMerger(NATIVE_CHAT_SOURCE_PRIORITY))

  const [hookState, hookStateStartedAt, hookHasWorkingSubagents] = useNativeChatHookStatus(paneKey)

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
    // Why: agent/path/owner rebinds can keep the same session; every source generation must invalidate pagination captured before it.
    transcriptEpochRef.current += 1
    setLoadingEarlier(false)
    transcriptCompanionControl.reset()
    if (!sessionId) {
      // No session id yet: surface live hook state on an empty transcript; backfills once the id arrives.
      setRead({ phase: 'ready', messages: [] })
      replaceList(appendMergerRef.current, [])
      setAppended([])
      setHasMore(false)
      return
    }

    let cancelled = false
    // Set by the first authoritative frame so the readSession seed below can't clobber a live snapshot.
    let frameArrived = false
    // Set once the host reports no transcript on disk yet, which makes a notFound
    // read known-good news rather than a failure worth surfacing.
    let transcriptPending = false
    limitRef.current = NATIVE_CHAT_INITIAL_LIMIT
    oldestOffsetRef.current = null
    setRead({ phase: 'loading' })
    replaceList(appendMergerRef.current, [])
    setAppended([])
    setHasMore(false)

    // Independent initial seed in case subscribe never delivers a snapshot; applied only until an authoritative frame lands so a live snapshot wins.
    const cancelSeedRead = startNativeChatSeedRead({
      read: () =>
        transport.readSession({
          agent,
          sessionId,
          limit: limitRef.current,
          ...(transcriptPath ? { transcriptPath } : {}),
          ...(sshConnectionId ? { sshConnectionId } : {})
        }),
      // A not-yet-flushed transcript: stay in 'loading' and retry with backoff instead of a permanent error (#8401).
      isPending: (result) => Boolean(result && 'error' in result && result.notFound),
      isSuperseded: () => frameArrived || transcriptPending,
      onResult: (result) => {
        if (result && 'error' in result) {
          setRead({ phase: 'error', error: result.error })
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
        ...(sshConnectionId ? { sshConnectionId } : {})
      },
      (frame) => {
        if (!cancelled) {
          if (frame.type === 'snapshot' || frame.type === 'replacement') {
            // Why: snapshots and inode replacements are authoritative generations; older pagination must not repaint them.
            if ('error' in frame && frame.error) {
              frameArrived = true
              transcriptEpochRef.current += 1
              setLoadingEarlier(false)
              setRead({ phase: 'error', error: frame.error })
              return
            }
            if (frame.type === 'snapshot' && frame.pending === true) {
              // No transcript exists yet (an agent that hasn't flushed, or was never
              // prompted). Move off 'loading' so the view stops spinning, but keep
              // an in-flight seed and appended tail eligible — this is not a read.
              transcriptPending = true
              cancelSeedRead()
              setRead({ phase: 'awaiting' })
              return
            }
            frameArrived = true
            transcriptEpochRef.current += 1
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
  }, [agent, sessionId, transcriptPath, transport, sshConnectionId, transcriptCompanionControl])

  const loadEarlier = useCallback(() => {
    if (!sessionId || loadingEarlier || !hasMore || read.phase !== 'ready') {
      return
    }
    const request = nextNativeChatPageRequest(limitRef.current, oldestOffsetRef.current)
    const requestEpoch = transcriptEpochRef.current
    const companionRevision = transcriptCompanionControl.revision()
    setLoadingEarlier(true)
    void transport
      .readSession({
        agent,
        sessionId,
        limit: request.limit,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(sshConnectionId ? { sshConnectionId } : {}),
        ...(request.mode === 'before' ? { beforeOffset: request.beforeOffset } : {})
      })
      .then((result) => {
        // Ignore a stale resolve from a swapped session or flipped owner — either would paint the wrong host's history.
        if (
          latestSessionId.current !== sessionId ||
          latestTransport.current !== transport ||
          transcriptEpochRef.current !== requestEpoch
        ) {
          return
        }
        if (!result || 'error' in result) {
          return
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
          setHasMore(
            resolveNativeChatHasMore(result.hasMore, result.messages.length, request.limit)
          )
          return
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
      })
      .catch(() => {
        // Swallow a rejected "load more" read: keep the already-loaded transcript intact rather than surface the rejection.
      })
      .finally(() => {
        // Clear the loading flag on the current epoch even when the result is discarded, so a stale resolve can't wedge it true.
        if (transcriptEpochRef.current === requestEpoch) {
          setLoadingEarlier(false)
        }
      })
  }, [
    agent,
    sessionId,
    transcriptPath,
    transport,
    sshConnectionId,
    hasMore,
    loadingEarlier,
    read.phase,
    transcriptCompanionControl
  ])

  // Computed outside the status memo so hookState churn (status-only) never re-runs the assembler.
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
    loadEarlier,
    appended
  ])
}
