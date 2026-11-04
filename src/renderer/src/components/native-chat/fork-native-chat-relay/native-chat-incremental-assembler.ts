// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-incremental-assembler.ts
// FORK-COPY-SHA: 965978bc78bf03a6a43187c1ed28fcffe0e01bb5
// Share full-rebuild merge rules; append new sorted tails cheaply, reset on base changes, and preserve full-rebuild equality at every prefix.

import {
  hasImagePromptMarker,
  isImageSourceUserTurn
} from '../../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import {
  compareMessages,
  mergeOne,
  sortForImageNormalization
} from '../native-chat-session-assembler'

export type IncrementalChatAssembler = {
  byId: Map<string, NativeChatMessage>
  byTurn: Map<string, NativeChatMessage>
  // Last emitted sorted output; stable reference until a mutation occurs.
  messages: NativeChatMessage[]
}

export function createIncrementalAssembler(): IncrementalChatAssembler {
  return { byId: new Map(), byTurn: new Map(), messages: [] }
}

/** Reset from a windowed base using the canonical transcript-only assembly path. */
export function reset(
  assembler: IncrementalChatAssembler,
  base: readonly NativeChatMessage[]
): NativeChatMessage[] {
  assembler.byId = new Map()
  assembler.byTurn = new Map()
  for (const message of base) {
    mergeOne(assembler.byId, assembler.byTurn, message)
  }
  assembler.messages = [...sortForImageNormalization(Array.from(assembler.byId.values()))]
  return assembler.messages
}

/** Merge through canonical rules; sort only a wholly new tail batch, otherwise resort the full map. */
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

  // Map growth below batch size means collisions/removals may have moved existing sort positions.
  const grewByBatch = assembler.byId.size === sizeBefore + incoming.length
  if (grewByBatch && isTailAppend(assembler.messages, incoming)) {
    // Sort only the new tail and preserve existing row identities.
    const tail = [...sortForImageNormalization(incoming)]
    assembler.messages = [...assembler.messages, ...tail]
    return assembler.messages
  }

  assembler.messages = [...sortForImageNormalization(Array.from(assembler.byId.values()))]
  return assembler.messages
}

/** Compare canonical appends by source position, including null and backward provider clocks. */
function isTailAppend(
  current: readonly NativeChatMessage[],
  incoming: readonly NativeChatMessage[]
): boolean {
  const last = current.at(-1)
  if (!last) {
    return true
  }
  if (
    incoming[0]?.source === last.source &&
    ((hasImagePromptMarker(last) &&
      incoming[0]?.timestamp === last.timestamp &&
      isImageSourceUserTurn(incoming[0]!)) ||
      (isImageSourceUserTurn(last) && hasImagePromptMarker(incoming[0]!)))
  ) {
    return false
  }
  // Prompt-first image folding displays companions before the prompt; retain their source high-water mark.
  const previous = current.at(-2)
  const boundary = previous && compareMessages(previous, last) > 0 ? previous : last
  for (const message of incoming) {
    // Supplemental insertion depends on the canonical sequence, not its last clock.
    if (boundary.transcriptOrder !== undefined && message.source !== 'transcript') {
      return false
    }
    if (message.timestamp === null && message.transcriptOrder === undefined) {
      return false
    }
    if (compareMessages(message, boundary) < 0) {
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
