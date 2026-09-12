import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'

/** Bounded retry budget for a transport failure mid-register or mid-wait (tech.md C5, item 6). */
export const ASK_CLI_TRANSPORT_RETRY_ATTEMPTS = 3
export const ASK_CLI_TRANSPORT_RETRY_DELAY_MS = 500

function isRetryableTransportError(error: unknown): boolean {
  return (
    error instanceof RuntimeClientError &&
    !(error instanceof RuntimeRpcFailureError) &&
    error.code === 'runtime_unavailable'
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Retries `attempt` on a bare transport failure (`runtime_unavailable`, never a
 * server-returned RPC failure) so a lost `ask.register`/`ask.wait` response is
 * recovered by resending the same idempotent request instead of surfacing a
 * spurious failure for a durable ask the host already accepted.
 */
export async function callWithTransportRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let index = 0; index < ASK_CLI_TRANSPORT_RETRY_ATTEMPTS; index += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (!isRetryableTransportError(error)) {
        throw error
      }
      lastError = error
      if (index < ASK_CLI_TRANSPORT_RETRY_ATTEMPTS - 1) {
        await delay(ASK_CLI_TRANSPORT_RETRY_DELAY_MS)
      }
    }
  }
  throw lastError
}
