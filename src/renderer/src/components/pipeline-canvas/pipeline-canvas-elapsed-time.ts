/**
 * Elapsed time for a running node's current attempt: a host-clock span
 * (publishedAt - startedAt) plus a same-clock local delta since that snapshot
 * was received. Never raw client-clock minus host-clock, so renderer/host
 * clock skew never leaks into the displayed value.
 */
export function pipelineNodeElapsedMs(args: {
  startedAt: string | undefined
  publishedAt: string | undefined
  nowMs: number
  receivedAtMs: number
}): number | null {
  if (!args.startedAt || !args.publishedAt) {
    return null
  }
  const startedAtMs = Date.parse(args.startedAt)
  const publishedAtMs = Date.parse(args.publishedAt)
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(publishedAtMs)) {
    return null
  }
  const baseElapsedMs = Math.max(0, publishedAtMs - startedAtMs)
  const localTickMs = Math.max(0, args.nowMs - args.receivedAtMs)
  return baseElapsedMs + localTickMs
}

export function formatPipelineElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) {
    return `${seconds}s`
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}
