// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-view-state.ts
// FORK-COPY-SHA: 07f4356a1678f6170a439527cd043f59b84343f0
// Pure mapping from an assembled NativeChatSession to the discrete view state the
// UI renders. Keeping it a single function (not branching inside the .tsx) makes
// the empty/loading/error/working/ready dispatch testable and keeps the render
// tree to one switch.

import type { NativeChatSession } from '../../../../../shared/native-chat-types'

/** The mutually-exclusive surfaces the chat view can show. `ready` and
 *  `working` both render the message list; `working` additionally shows the
 *  live in-flight indicator. The rest are full-pane states. */
export type NativeChatViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'ready'; isWorking: false; error?: string }
  | { kind: 'ready'; isWorking: true; error?: string }

const NATIVE_CHAT_READ_FAILED = 'Conversation could not be loaded.'

/**
 * Decide which surface to render. Any renderable message wins over every
 * full-pane surface — including error — so optimistic first sends never get
 * replaced by a placeholder while transcript discovery catches up.
 *
 * A failing read is still reported, as `error` alongside the messages: a
 * permanent failure (no read permission, an agent whose transcripts cannot be
 * decoded) would otherwise be indistinguishable from a healthy pane.
 */
export function selectNativeChatViewState(session: NativeChatSession): NativeChatViewState {
  if (session.messages.length > 0) {
    return {
      kind: 'ready',
      isWorking: session.status === 'working',
      ...(session.status === 'error' ? { error: session.error ?? NATIVE_CHAT_READ_FAILED } : {})
    }
  }
  if (session.status === 'error') {
    return { kind: 'error', message: session.error ?? NATIVE_CHAT_READ_FAILED }
  }
  if (session.status === 'loading') {
    return { kind: 'loading' }
  }
  // A KNOWN session working with nothing to show is a transcript that has not
  // flushed yet, so hold the loading surface rather than flashing empty (#11032).
  // The status stays 'working', so the composer keeps Stop the moment a bubble
  // lands — forcing 'loading' upstream instead rendered an idle pane mid-turn.
  if (session.status === 'working' && session.sessionId !== null) {
    return { kind: 'loading' }
  }
  // Empty wins over a transient 'working' hook so a just-toggled, pre-session
  // pane shows a clear empty state instead of a spinner over nothing.
  return { kind: 'empty' }
}
