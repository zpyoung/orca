// Relay-side buffer between the transcript watcher and the client's pull.
//
// The watcher emits decoded turns as fast as the agent writes them; the client
// pulls over a shared SSH channel. Large payloads cannot ride notifications (an
// over-capacity producer frame is dropped silently), so the relay holds frames
// here and sends only a tiny ping. Overflow collapses to a re-read rather than
// growing without bound — the same degradation the watcher already applies to a
// rotated file.

import type { NativeChatMessage } from '../../shared/native-chat-types'
import {
  nativeChatCompanionFrameFields,
  type NativeChatCompanionFrameFields,
  type NativeChatTranscriptCompanion
} from '../../shared/native-chat-transcript-companion'
import {
  clipNativeChatMessageToBytes,
  estimateNativeChatMessageBytes,
  NATIVE_CHAT_RELAY_BYTE_BUDGET
} from '../../main/native-chat/fork-native-chat-relay/transcript-wire-budget'

/** No single message may exceed a pull's budget, or the drain could never progress. */
const MAX_MESSAGE_BYTES = Math.floor(NATIVE_CHAT_RELAY_BYTE_BUDGET / 2)
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024

export type NativeChatSnapshotFrame = NativeChatCompanionFrameFields & {
  kind: 'snapshot' | 'replace'
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset?: number
  /** Set when the initial drain failed. Not terminal — the watcher keeps
   *  retrying, so a later frame supersedes it. */
  error?: string
}

export type NativeChatOutboxFrame =
  | NativeChatSnapshotFrame
  | (NativeChatCompanionFrameFields & { kind: 'append'; messages: NativeChatMessage[] })

export type NativeChatOutbox = {
  frames: NativeChatOutboxFrame[]
  bytes: number
  /** Set when frames were discarded; the next drain must re-read the tail instead. */
  replacePending: boolean
  /** Monotonic; lets the client coalesce pings and detect that it is behind. */
  seq: number
}

export function createNativeChatOutbox(): NativeChatOutbox {
  return { frames: [], bytes: 0, replacePending: false, seq: 0 }
}

function clipAll(messages: readonly NativeChatMessage[]): NativeChatMessage[] {
  return messages.map((message) => clipNativeChatMessageToBytes(message, MAX_MESSAGE_BYTES))
}

function framePayloadBytes(messages: readonly NativeChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateNativeChatMessageBytes(message), 0)
}

function collapse(outbox: NativeChatOutbox): void {
  outbox.frames = []
  outbox.bytes = 0
  outbox.replacePending = true
}

// Frame count needs no bound of its own: appends coalesce into the trailing
// frame and a snapshot replaces the buffer, so bytes are the only thing that grows.
function enforceBounds(outbox: NativeChatOutbox): void {
  if (outbox.bytes > MAX_OUTBOX_BYTES) {
    collapse(outbox)
  }
}

/** A fresh authoritative generation: supersedes anything already buffered. */
export function pushNativeChatSnapshot(
  outbox: NativeChatOutbox,
  frame: Omit<NativeChatSnapshotFrame, 'messages'> & { messages: readonly NativeChatMessage[] }
): void {
  const messages = clipAll(frame.messages)
  outbox.frames = [{ ...frame, messages }]
  outbox.bytes = framePayloadBytes(messages)
  outbox.replacePending = false
  outbox.seq++
}

export function pushNativeChatAppend(
  outbox: NativeChatOutbox,
  messages: readonly NativeChatMessage[],
  companion?: NativeChatTranscriptCompanion
): void {
  outbox.seq++
  const fields = nativeChatCompanionFrameFields(companion)
  if (messages.length === 0 && !companion) {
    return
  }
  // Buffered even while a re-read is pending: the watcher advances past these
  // lines, so a re-read that raced ahead of them would otherwise lose the turn.
  // The client merges by id, making the overlap with the replacement harmless.
  const clipped = clipAll(messages)
  const tail = outbox.frames.at(-1)
  // Coalesce consecutive appends so a fast stream cannot exhaust the frame bound.
  if (tail?.kind === 'append') {
    tail.messages.push(...clipped)
    Object.assign(tail, fields)
  } else {
    outbox.frames.push({ kind: 'append', messages: clipped, ...fields })
  }
  outbox.bytes += framePayloadBytes(clipped)
  enforceBounds(outbox)
}

export type NativeChatOutboxDrain = {
  frames: NativeChatOutboxFrame[]
  seq: number
  /** True when frames remain; the client pulls again immediately. */
  more: boolean
  /** True when the caller must re-read the tail before returning anything. */
  replacePending: boolean
}

/**
 * Split the leading messages of an oversized coalesced append into their own
 * frame, leaving the rest queued. Returns null when the frame cannot give
 * anything back — a snapshot (authoritative, not divisible) or a lone message.
 *
 * Why split at all: a drained frame that overruns the response budget fails its
 * own request, and the frame is already out of the buffer by then, so the turns
 * it carried are gone until something forces a fresh snapshot.
 */
function splitOversizedAppend(
  frame: NativeChatOutboxFrame,
  maxBytes: number
): NativeChatOutboxFrame | null {
  if (frame.kind !== 'append' || frame.messages.length <= 1) {
    return null
  }
  const head: NativeChatMessage[] = []
  let used = 0
  for (const message of frame.messages) {
    const size = estimateNativeChatMessageBytes(message)
    if (head.length > 0 && used + size > maxBytes) {
      break
    }
    head.push(message)
    used += size
  }
  if (head.length === frame.messages.length) {
    return null
  }
  // The companion describes the newest turn, so it stays with the remainder.
  frame.messages = frame.messages.slice(head.length)
  return { kind: 'append', messages: head }
}

/**
 * Take as many buffered frames as fit `maxBytes`. Always yields at least one
 * frame when any are buffered, so a pull loop cannot stall on an outsized frame.
 */
export function drainNativeChatOutbox(
  outbox: NativeChatOutbox,
  maxBytes: number = NATIVE_CHAT_RELAY_BYTE_BUDGET
): NativeChatOutboxDrain {
  if (outbox.replacePending) {
    return { frames: [], seq: outbox.seq, more: false, replacePending: true }
  }
  const frames: NativeChatOutboxFrame[] = []
  let used = 0
  while (outbox.frames.length > 0) {
    const next = outbox.frames[0]!
    const size = framePayloadBytes(next.messages)
    if (used + size > maxBytes) {
      if (frames.length > 0) {
        break
      }
      const head = splitOversizedAppend(next, maxBytes)
      if (head) {
        outbox.bytes = Math.max(0, outbox.bytes - framePayloadBytes(head.messages))
        frames.push(head)
        break
      }
    }
    outbox.frames.shift()
    outbox.bytes = Math.max(0, outbox.bytes - size)
    used += size
    frames.push(next)
  }
  return {
    frames,
    seq: outbox.seq,
    more: outbox.frames.length > 0,
    replacePending: false
  }
}

/** Clear the re-read flag once the caller has produced the replacement frame. */
export function resolveNativeChatReplacePending(outbox: NativeChatOutbox): void {
  outbox.replacePending = false
}
