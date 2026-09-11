// Reading the untrusted params of a native-chat relay request. A client can
// send anything, so every field is coerced here rather than at each use.

const DEFAULT_LIMIT = 300
// Above this a single response would not fit the connection's writer budget
// anyway, and the byte budget would trim it right back down.
const MAX_LIMIT = 2000

export function readRelayString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function readRelayLimit(params: Record<string, unknown>): number {
  const value = params.limit
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_LIMIT)
    : DEFAULT_LIMIT
}
