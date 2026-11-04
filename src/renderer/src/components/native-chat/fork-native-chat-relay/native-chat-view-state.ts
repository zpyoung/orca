// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-view-state.ts
// FORK-COPY-SHA: 965978bc78bf03a6a43187c1ed28fcffe0e01bb5
// Pure mapping from an assembled NativeChatSession to the discrete view state the
// UI renders. Keeping it a single function (not branching inside the .tsx) makes
// the empty/loading/error/working/ready dispatch testable and keeps the render
// tree to one switch.

import type { NativeChatSession } from '../../../../../shared/native-chat/native-chat-types'

/** Ready renders the transcript; isWorking adds live activity. Other variants replace the pane. */
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
  // Unflushed known sessions stay visually loading, retaining working status for Stop (#11032).
  if (session.status === 'working' && session.sessionId !== null) {
    return { kind: 'loading' }
  }
  // Before session discovery, transient working hooks must not replace the empty state with a spinner.
  return { kind: 'empty' }
}
