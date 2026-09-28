/** Bound on worker-authored text carried into a deviation, an owner brief or a judgment state. */
export const WORKER_LAST_MESSAGE_MAX_BYTES = 4 * 1024

/**
 * Keeps the newest `maxBytes` UTF-8 bytes of `text`. A worker's question sits at the end of its
 * message, so the head is what gets dropped. UTF-8 never encodes a UTF-16 code unit in fewer than
 * one byte, so the result also fits a code-unit limit of the same size.
 */
export function clipWorkerLastMessage(
  text: string,
  maxBytes: number = WORKER_LAST_MESSAGE_MAX_BYTES
): { text: string; truncated: boolean } {
  const trimmed = text.trim()
  const encoded = new TextEncoder().encode(trimmed)
  if (encoded.byteLength <= maxBytes) {
    return { text: trimmed, truncated: false }
  }
  // a cut inside a multi-byte sequence decodes to U+FFFD, which is dropped rather than shown
  const tail = new TextDecoder()
    .decode(encoded.subarray(encoded.byteLength - maxBytes))
    .replace(/^�+/, '')
  return { text: tail.trim(), truncated: true }
}
