import { useEffect, useRef, useState } from 'react'
import {
  createNativeChatTranscriptRetention,
  encodeNativeChatTranscriptIdentity
} from '../../../../shared/native-chat-transcript-retention'
import {
  isNativeChatTranscriptUnsettled,
  useNativeChatLiveSession,
  type NativeChatLiveSession,
  type UseNativeChatLiveSessionArgs
} from './fork-native-chat-relay/use-native-chat-live-session'

/** Keeps one committed conversation visible while its exact source rebinds. */
export function useNativeChatRetainedSession(
  args: UseNativeChatLiveSessionArgs
): NativeChatLiveSession {
  const session = useNativeChatLiveSession(args)
  const identity = encodeNativeChatTranscriptIdentity([
    args.paneKey,
    args.runtimeEnvironmentId ?? null,
    // Part of the identity because two ssh hosts can hand back the same agent
    // session id; without it a rebind would show the first host's turns.
    args.sshConnectionId ?? null,
    args.agent,
    args.sessionId,
    args.transcriptPath ?? null
  ])
  const activeIdentityRef = useRef(identity)
  const retentionRef = useRef(createNativeChatTranscriptRetention())
  const sessionMatchesIdentity = activeIdentityRef.current === identity
  // The live hook clears its list synchronously when it rebinds, but that is a
  // queued update: a higher-priority render can observe a matching identity while
  // the list still holds the previous source. Treat it as ours only once we have
  // seen it empty under this identity. State, not a ref — a discarded render must
  // not leave the list marked acknowledged.
  const [liveListIdentity, setLiveListIdentity] = useState(identity)
  if (session.messages.length === 0 && liveListIdentity !== identity) {
    setLiveListIdentity(identity)
  }
  const canServeLiveList = sessionMatchesIdentity && liveListIdentity === identity
  // An unacknowledged list is not settled history, whatever the live hook calls it —
  // reporting its phase would let retention hand back the previous source's turns.
  const readPhase = canServeLiveList ? session.readPhase : 'loading'

  useEffect(() => {
    activeIdentityRef.current = identity
  }, [identity])
  useEffect(() => {
    if (canServeLiveList && args.sessionId !== null && session.readPhase === 'ready') {
      retentionRef.current.capture(identity, session.messages)
    }
  }, [args.sessionId, identity, session.messages, session.readPhase, canServeLiveList])

  const retained = retentionRef.current.visible({
    identity,
    messages: session.messages,
    settled: readPhase === 'ready',
    loading: isNativeChatTranscriptUnsettled(readPhase)
  })
  // A retrying or errored base read still carries live subscribe appends, so falling
  // through to them beats showing nothing — but only for a list already proven ours.
  const messages = retained.length > 0 || !canServeLiveList ? retained : session.messages
  if (messages === session.messages && readPhase === session.readPhase) {
    return session
  }
  return {
    ...session,
    messages,
    readPhase,
    // Live work is the only status worth carrying across a rebind — it drives Stop
    // and the typing indicator. Anything else, including the previous source's
    // error, must not outlive the identity it belongs to.
    ...(canServeLiveList || (messages.length > 0 && session.status === 'working')
      ? {}
      : { status: 'loading' as const, error: undefined })
  }
}
