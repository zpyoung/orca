// FORK-COPY-OF: src/renderer/src/components/native-chat/native-chat-pagination.ts
// FORK-COPY-SHA: 965978bc78bf03a6a43187c1ed28fcffe0e01bb5
export const NATIVE_CHAT_INITIAL_LIMIT = 300
export const NATIVE_CHAT_PAGE = 200

/** Only applied moves history older; superseded belongs to a newer read generation. */
export type NativeChatOlderPageResult =
  | 'applied'
  | 'exhausted'
  | 'unchanged'
  | 'failed'
  | 'superseded'

export function nextNativeChatLimit(currentLimit: number): number {
  return currentLimit + NATIVE_CHAT_PAGE
}

/** A full window may have older rows; a short read proves exhaustion. */
export function hasMoreNativeChatHistory(returnedCount: number, requestedLimit: number): boolean {
  return returnedCount >= requestedLimit
}

/**
 * Prefer the reader's own answer over inferring one from the count.
 *
 * Inference assumes a read is bounded only by turn count. A read bounded by
 * bytes (the ssh relay path, where a response has to fit the connection's shared
 * writer budget) returns fewer messages than requested while older history still
 * exists — inference would call that the head of the transcript and retire
 * load-earlier.
 */
export function resolveNativeChatHasMore(
  reported: boolean | undefined,
  returnedCount: number,
  requestedLimit: number
): boolean {
  return typeof reported === 'boolean'
    ? reported
    : hasMoreNativeChatHistory(returnedCount, requestedLimit)
}

/** How to ask for the next older page. */
export type NativeChatPageRequest =
  /** Read the page ending at a known byte offset and prepend it. The only mode
   *  that can reach older history when a read is bounded by bytes: growing the
   *  limit just re-budgets the same tail. */
  | { mode: 'before'; limit: number; beforeOffset: number }
  /** Re-read a larger tail and replace. Fallback for a reader that reports no
   *  offset (an older remote runtime). */
  | { mode: 'grow'; limit: number }

export function nextNativeChatPageRequest(
  currentLimit: number,
  oldestOffset: number | null
): NativeChatPageRequest {
  if (oldestOffset !== null && oldestOffset > 0) {
    return { mode: 'before', limit: NATIVE_CHAT_PAGE, beforeOffset: oldestOffset }
  }
  return { mode: 'grow', limit: nextNativeChatLimit(currentLimit) }
}

/**
 * Whether an offset-paged read left older history behind.
 *
 * An empty page or an offset that did not move means the read reached the head;
 * treating either as "more" would let load-earlier retrigger forever.
 */
export function hasMoreBeforeNativeChatPage(
  reported: boolean | undefined,
  returnedCount: number,
  requestedBefore: number,
  returnedBefore: number | undefined
): boolean {
  if (returnedCount === 0 || returnedBefore === undefined || returnedBefore >= requestedBefore) {
    return false
  }
  return reported ?? returnedCount >= NATIVE_CHAT_PAGE
}
