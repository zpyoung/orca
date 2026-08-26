// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-incremental-assembler.ts
// FORK-COPY-SHA: 6e4f817101daa18d82824b69243d9079baa9c416
// Incremental native-chat assembler. The full `assembleNativeChatSession` does
// an O(n log n) Map-build + sort on every call; on the hot streaming path the
// agent emits many small append batches over a growing transcript, so the full
// rebuild is quadratic per turn (#17). This splits the two mutation axes:
//
//   - base axis (session swap / loadEarlier re-read): rare, user-driven → reset,
//     a full rebuild that is byte-for-byte identical to assembleNativeChatSession.
//   - append axis (live streaming): hot → applyAppends, which feeds only the new
//     batch through the SAME mergeOne rule and splices at the tail when the batch
//     is purely-new and already-sorted, falling back to a full re-sort otherwise.
//
// Correctness invariant: applyAppends output deep-equals a full rebuild over
// base ++ all-appends for every prefix (locked by the oracle differential test).

import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { compareMessages, mergeOne } from '../native-chat-session-assembler'

export type IncrementalChatAssembler = {
  byId: Map<string, NativeChatMessage>
  byTurn: Map<string, NativeChatMessage>
  // Last emitted sorted output; stable reference until a mutation occurs.
  messages: NativeChatMessage[]
}

export function createIncrementalAssembler(): IncrementalChatAssembler {
  return { byId: new Map(), byTurn: new Map(), messages: [] }
}

/** Rebuild the assembled state from a base list (the windowed read). Canonical
 *  path — equivalent to assembleNativeChatSession over `{ transcript: base }`. */
export function reset(
  assembler: IncrementalChatAssembler,
  base: readonly NativeChatMessage[]
): NativeChatMessage[] {
  assembler.byId = new Map()
  assembler.byTurn = new Map()
  for (const message of base) {
    mergeOne(assembler.byId, assembler.byTurn, message)
  }
  assembler.messages = Array.from(assembler.byId.values()).sort(compareMessages)
  return assembler.messages
}

/** Fold a live append batch through the same merge rule as the full rebuild.
 *  Fast path: when every incoming message is a brand-new id, has a brand-new
 *  turnKey-free identity (no merge/removal), and sorts at/after the current
 *  tail, splice the batch in (O(k log k)). Any ambiguity → full re-sort of the
 *  whole map (still correct, just O(n log n) for that one rare batch). */
export function applyAppends(
  assembler: IncrementalChatAssembler,
  incoming: readonly NativeChatMessage[]
): NativeChatMessage[] {
  if (incoming.length === 0) {
    return assembler.messages
  }

  const sizeBefore = assembler.byId.size
  for (const message of incoming) {
    mergeOne(assembler.byId, assembler.byTurn, message)
  }

  // A merge or removal happened if the map didn't grow by exactly the batch
  // size — some incoming id/turn collided with or superseded an existing entry,
  // which can change an existing entry's sort position. Fall back to re-sort.
  const grewByBatch = assembler.byId.size === sizeBefore + incoming.length
  if (grewByBatch && isTailAppend(assembler.messages, incoming)) {
    // Every incoming message is new and sorts at/after the tail: splice the
    // batch in its own sorted order without touching the existing prefix.
    const tail = [...incoming].sort(compareMessages)
    assembler.messages = [...assembler.messages, ...tail]
    return assembler.messages
  }

  assembler.messages = Array.from(assembler.byId.values()).sort(compareMessages)
  return assembler.messages
}

/** True when the whole batch sorts strictly at/after the current last message
 *  AND is internally unambiguous to splice. A null timestamp in the batch sorts
 *  before any real timestamp, so it can never be a pure tail append — bail to
 *  the full re-sort. */
function isTailAppend(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): boolean {
  const last = current.at(-1)
  if (!last) {
    return true
  }
  for (const message of incoming) {
    // Null timestamp (sorts to the front) can never be a tail append.
    if (message.timestamp === null) {
      return false
    }
    if (compareMessages(message, last) < 0) {
      return false
    }
  }
  return true
}

/** An assembler plus the inputs it was last fed, so a caller re-deriving the
 *  transcript every render can tell a tail extension from a base-axis change. */
export type NativeChatTranscriptCache = {
  assembler: IncrementalChatAssembler
  applied: readonly NativeChatMessage[]
  baseSignature: string | null
  base: readonly NativeChatMessage[]
}

export function createNativeChatTranscriptCache(): NativeChatTranscriptCache {
  return {
    assembler: createIncrementalAssembler(),
    applied: [],
    baseSignature: null,
    base: []
  }
}

/** Assemble `base ++ appended`, reusing cached state when the transcript only
 *  grew at the tail. Anything else — a new `baseSignature`, or a re-read that
 *  replaced the base list — resets, so the cache can never drift from what a
 *  full rebuild would produce (#17). */
export function assembleCachedTranscript(
  cache: NativeChatTranscriptCache,
  base: readonly NativeChatMessage[],
  appended: readonly NativeChatMessage[],
  baseSignature: string
): NativeChatMessage[] {
  const transcript = appended.length > 0 ? [...base, ...appended] : (base as NativeChatMessage[])
  const baseChanged = baseSignature !== cache.baseSignature || base !== cache.base
  const isSuffixExtension =
    !baseChanged &&
    transcript.length >= cache.applied.length &&
    sharesNativeChatPrefix(transcript, cache.applied, cache.applied.length)

  let out: NativeChatMessage[]
  if (isSuffixExtension && transcript.length > cache.applied.length) {
    out = applyAppends(cache.assembler, transcript.slice(cache.applied.length))
  } else if (isSuffixExtension) {
    out = cache.assembler.messages
  } else {
    out = reset(cache.assembler, transcript)
  }
  cache.baseSignature = baseSignature
  cache.base = base
  cache.applied = transcript
  return out
}

/** True when `whole`'s first `len` entries are referentially identical to
 *  `prefix` (a tail-extension), so the caller can splice just the suffix. */
export function sharesNativeChatPrefix(
  whole: readonly NativeChatMessage[],
  prefix: readonly NativeChatMessage[],
  len: number
): boolean {
  for (let i = 0; i < len; i += 1) {
    if (whole[i] !== prefix[i]) {
      return false
    }
  }
  return true
}
