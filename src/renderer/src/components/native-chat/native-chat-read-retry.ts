// Retry policy for a transcript that is not on disk yet.
//
// A `notFound` miss is not a failure: agents create the JSONL lazily. Claude
// Code buffers a new session's records and only creates the file on its first
// flush — measured at 73s, 90s and 152s after the session's own first record.
// A window under that turns a still-booting session into a permanent read
// error, which then outranks the user's first message in the pane.

const NOTFOUND_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]
const NOTFOUND_RETRY_FIXED_DELAY_MS = 10_000

/** How long a `notFound` miss keeps retrying before it becomes an error. */
export const NOTFOUND_RETRY_WINDOW_MS = 300_000

export function notFoundRetryDelayMs(attempt: number): number {
  return NOTFOUND_RETRY_DELAYS_MS[attempt] ?? NOTFOUND_RETRY_FIXED_DELAY_MS
}

/** True while a miss is still worth retrying rather than surfacing. */
export function shouldRetryNativeChatNotFound(startedAt: number, now: number): boolean {
  return now - startedAt < NOTFOUND_RETRY_WINDOW_MS
}
