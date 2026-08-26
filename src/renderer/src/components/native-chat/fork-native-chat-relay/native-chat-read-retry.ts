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

export type NativeChatSeedReadOptions<TResult> = {
  read: () => Promise<TResult>
  /** True when the transcript is not on disk yet, so the read is worth repeating. */
  isPending: (result: TResult) => boolean
  onResult: (result: TResult) => void
  onError: (error: unknown) => void
  /** True once an authoritative source owns the transcript, so a late read must not repaint it. */
  isSuperseded: () => boolean
}

/**
 * Reads a transcript, repeating on a still-unflushed miss until the retry window
 * closes. Returns a cancel handle owning the pending retry timer, so a caller
 * tearing down releases every allocation this made.
 */
export function startNativeChatSeedRead<TResult>(
  options: NativeChatSeedReadOptions<TResult>
): () => void {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const startedAt = Date.now()

  function attemptRead(attempt: number): void {
    if (cancelled || options.isSuperseded()) {
      return
    }
    void options
      .read()
      .then((result) => {
        if (cancelled || options.isSuperseded()) {
          return
        }
        if (options.isPending(result) && shouldRetryNativeChatNotFound(startedAt, Date.now())) {
          retryTimer = setTimeout(() => {
            retryTimer = null
            attemptRead(attempt + 1)
          }, notFoundRetryDelayMs(attempt))
          return
        }
        options.onResult(result)
      })
      .catch((error: unknown) => {
        if (!cancelled && !options.isSuperseded()) {
          options.onError(error)
        }
      })
  }

  attemptRead(0)

  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
}
